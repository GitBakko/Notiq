import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

// Mock sibling services
vi.mock('../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import * as emailService from '../email.service';
import * as notificationService from '../notification.service';

import {
  createGroup,
  getMyGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  addMember,
  removeMember,
  removePendingInvite,
  processPendingGroupInvites,
  getGroupsForSharing,
  hasPendingGroupInvite,
} from '../group.service';
import { makeUser, makeGroup, makeGroupMember, makePendingGroupInvite } from '../../__tests__/factories';
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../utils/errors';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const owner = makeUser({ id: 'owner-1', email: 'owner@test.com', name: 'Owner', locale: 'en' });
const member = makeUser({ id: 'member-1', email: 'member@test.com', name: 'Member', locale: 'en' });
const stranger = makeUser({ id: 'stranger-1', email: 'stranger@test.com', name: 'Stranger' });
const group = makeGroup({ id: 'group-1', name: 'Test Group', ownerId: owner.id });

const groupWithOwner = {
  ...group,
  owner: { id: owner.id, name: owner.name, email: owner.email, locale: owner.locale },
  members: [
    { groupId: group.id, userId: owner.id, joinedAt: new Date(), user: { id: owner.id, email: owner.email, name: owner.name, avatarUrl: null } },
  ],
  pendingInvites: [],
};

const groupWithMember = {
  ...groupWithOwner,
  members: [
    ...groupWithOwner.members,
    { groupId: group.id, userId: member.id, joinedAt: new Date(), user: { id: member.id, email: member.email, name: member.name, avatarUrl: null } },
  ],
};

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createGroup
// ---------------------------------------------------------------------------
describe('createGroup', () => {
  it('creates a group with the given owner', async () => {
    const expected = { ...groupWithOwner };
    prismaMock.group.create.mockResolvedValue(expected);

    const result = await createGroup(owner.id, { name: 'Test Group', description: 'A test group' });

    expect(result).toEqual(expected);
    expect(prismaMock.group.create).toHaveBeenCalledWith({
      data: { name: 'Test Group', description: 'A test group', ownerId: owner.id },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        pendingInvites: { select: { id: true, email: true, createdAt: true } },
      },
    });
  });

  it('creates a group without description', async () => {
    prismaMock.group.create.mockResolvedValue(groupWithOwner);

    await createGroup(owner.id, { name: 'No Desc Group' });

    expect(prismaMock.group.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'No Desc Group', description: undefined, ownerId: owner.id },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getMyGroups
// ---------------------------------------------------------------------------
describe('getMyGroups', () => {
  it('returns groups where user is owner', async () => {
    const owned = [{ ...groupWithOwner, _count: { members: 1 } }];
    prismaMock.group.findMany
      .mockResolvedValueOnce(owned)   // owned query
      .mockResolvedValueOnce([]);     // memberOf query

    const result = await getMyGroups(owner.id);

    expect(result.owned).toEqual(owned);
    expect(result.memberOf).toEqual([]);
    expect(prismaMock.group.findMany).toHaveBeenCalledTimes(2);
  });

  it('includes groups where user is member (not owner)', async () => {
    const memberOfGroup = {
      ...group,
      ownerId: 'other-owner',
      owner: { id: 'other-owner', email: 'other@test.com', name: 'Other' },
      members: [{ groupId: group.id, userId: member.id, joinedAt: new Date(), user: { id: member.id, email: member.email, name: member.name, avatarUrl: null } }],
      _count: { members: 2 },
    };

    prismaMock.group.findMany
      .mockResolvedValueOnce([])             // owned query
      .mockResolvedValueOnce([memberOfGroup]); // memberOf query

    const result = await getMyGroups(member.id);

    expect(result.owned).toEqual([]);
    expect(result.memberOf).toHaveLength(1);
    expect(result.memberOf[0].ownerId).toBe('other-owner');
  });
});

// ---------------------------------------------------------------------------
// getGroup
// ---------------------------------------------------------------------------
describe('getGroup', () => {
  it('returns group with members for the owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithMember);

    const result = await getGroup(group.id, owner.id);

    expect(result).toEqual(groupWithMember);
    expect(prismaMock.group.findUnique).toHaveBeenCalledWith({
      where: { id: group.id },
      include: {
        owner: { select: { id: true, email: true, name: true } },
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        pendingInvites: { select: { id: true, email: true, createdAt: true } },
      },
    });
  });

  it('returns group with members for a member', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithMember);

    const result = await getGroup(group.id, member.id);

    expect(result).toEqual(groupWithMember);
  });

  it('throws NotFoundError when group does not exist', async () => {
    prismaMock.group.findUnique.mockResolvedValue(null);

    await expect(getGroup('nonexistent', owner.id)).rejects.toThrow(NotFoundError);
    await expect(getGroup('nonexistent', owner.id)).rejects.toThrow('errors.groups.notFound');
  });

  it('throws ForbiddenError for non-member', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithMember);

    await expect(getGroup(group.id, stranger.id)).rejects.toThrow(ForbiddenError);
    await expect(getGroup(group.id, stranger.id)).rejects.toThrow('errors.common.accessDenied');
  });
});

// ---------------------------------------------------------------------------
// updateGroup
// ---------------------------------------------------------------------------
describe('updateGroup', () => {
  it('updates name and description', async () => {
    prismaMock.group.findUnique.mockResolvedValue(group);
    const updated = { ...groupWithOwner, name: 'Updated', description: 'New desc' };
    prismaMock.group.update.mockResolvedValue(updated);

    const result = await updateGroup(group.id, owner.id, { name: 'Updated', description: 'New desc' });

    expect(result).toEqual(updated);
    expect(prismaMock.group.update).toHaveBeenCalledWith({
      where: { id: group.id },
      data: { name: 'Updated', description: 'New desc' },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        pendingInvites: { select: { id: true, email: true, createdAt: true } },
      },
    });
  });

  it('throws ForbiddenError for non-owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(group);

    await expect(updateGroup(group.id, member.id, { name: 'Hack' })).rejects.toThrow(ForbiddenError);
    await expect(updateGroup(group.id, member.id, { name: 'Hack' })).rejects.toThrow('errors.common.notFoundOrDenied');
  });

  it('throws ForbiddenError when group does not exist', async () => {
    prismaMock.group.findUnique.mockResolvedValue(null);

    await expect(updateGroup('nonexistent', owner.id, { name: 'X' })).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// deleteGroup
// ---------------------------------------------------------------------------
describe('deleteGroup', () => {
  it('deletes group as owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue({ ...group, avatarUrl: null });
    prismaMock.group.delete.mockResolvedValue(group);

    await deleteGroup(group.id, owner.id);

    expect(prismaMock.group.delete).toHaveBeenCalledWith({ where: { id: group.id } });
  });

  it('throws ForbiddenError for non-owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(group);

    await expect(deleteGroup(group.id, member.id)).rejects.toThrow(ForbiddenError);
    await expect(deleteGroup(group.id, member.id)).rejects.toThrow('errors.common.notFoundOrDenied');
    expect(prismaMock.group.delete).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError when group does not exist', async () => {
    prismaMock.group.findUnique.mockResolvedValue(null);

    await expect(deleteGroup('nonexistent', owner.id)).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------
describe('addMember', () => {
  const groupWithOwnerInclude = {
    ...group,
    owner: { id: owner.id, name: owner.name, email: owner.email, locale: 'en' },
  };

  it('adds a registered user as member', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerInclude);
    prismaMock.user.findUnique.mockResolvedValue(member);
    prismaMock.groupMember.findUnique.mockResolvedValue(null);
    prismaMock.groupMember.create.mockResolvedValue(makeGroupMember({ groupId: group.id, userId: member.id }));

    const result = await addMember(group.id, owner.id, member.email);

    expect(result).toEqual({ type: 'registered', userId: member.id });
    expect(prismaMock.groupMember.create).toHaveBeenCalledWith({ data: { groupId: group.id, userId: member.id } });
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      member.id,
      'GROUP_INVITE',
      'Added to Group',
      expect.stringContaining(group.name),
      expect.objectContaining({ groupId: group.id, groupName: group.name }),
    );
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      member.email,
      'GROUP_MEMBER_ADDED',
      expect.objectContaining({ groupName: group.name, ownerName: owner.name }),
    );
  });

  it('creates pending invite for unregistered email', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerInclude);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.pendingGroupInvite.upsert.mockResolvedValue({});

    const result = await addMember(group.id, owner.id, 'unknown@test.com');

    expect(result).toEqual({ type: 'pending', email: 'unknown@test.com' });
    expect(prismaMock.pendingGroupInvite.upsert).toHaveBeenCalledWith({
      where: { groupId_email: { groupId: group.id, email: 'unknown@test.com' } },
      update: { invitedBy: owner.id },
      create: { groupId: group.id, email: 'unknown@test.com', invitedBy: owner.id },
    });
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      'unknown@test.com',
      'GROUP_INVITE_REGISTER',
      expect.objectContaining({ groupName: group.name, ownerName: owner.name }),
    );
  });

  it('throws BadRequestError when adding self (owner email)', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerInclude);

    await expect(addMember(group.id, owner.id, owner.email)).rejects.toThrow(BadRequestError);
    await expect(addMember(group.id, owner.id, owner.email)).rejects.toThrow('errors.groups.cannotAddSelf');
  });

  it('throws ConflictError if user is already a member', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerInclude);
    prismaMock.user.findUnique.mockResolvedValue(member);
    prismaMock.groupMember.findUnique.mockResolvedValue(makeGroupMember({ groupId: group.id, userId: member.id }));

    await expect(addMember(group.id, owner.id, member.email)).rejects.toThrow(ConflictError);
    await expect(addMember(group.id, owner.id, member.email)).rejects.toThrow('errors.groups.alreadyMember');
  });

  it('throws ForbiddenError for non-owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue({ ...groupWithOwnerInclude, ownerId: 'someone-else' });

    await expect(addMember(group.id, owner.id, member.email)).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------
describe('removeMember', () => {
  const groupWithOwnerSelect = {
    ...group,
    owner: { id: owner.id, name: owner.name, email: owner.email },
  };

  it('removes a member and sends notifications', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerSelect);
    prismaMock.groupMember.findUnique.mockResolvedValue({
      ...makeGroupMember({ groupId: group.id, userId: member.id }),
      user: { email: member.email, name: member.name, locale: 'en' },
    });
    prismaMock.groupMember.delete.mockResolvedValue({});

    await removeMember(group.id, owner.id, member.id);

    expect(prismaMock.groupMember.delete).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: group.id, userId: member.id } },
    });
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      member.id,
      'GROUP_REMOVE',
      'Removed from Group',
      expect.stringContaining(group.name),
      expect.objectContaining({ groupId: group.id, groupName: group.name }),
    );
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      member.email,
      'GROUP_MEMBER_REMOVED',
      expect.objectContaining({ groupName: group.name, ownerName: owner.name }),
    );
  });

  it('throws ForbiddenError for non-owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerSelect);

    await expect(removeMember(group.id, member.id, stranger.id)).rejects.toThrow(ForbiddenError);
  });

  it('throws BadRequestError when owner tries to remove self', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerSelect);

    await expect(removeMember(group.id, owner.id, owner.id)).rejects.toThrow(BadRequestError);
    await expect(removeMember(group.id, owner.id, owner.id)).rejects.toThrow('errors.groups.cannotRemoveSelfOwner');
  });

  it('throws NotFoundError when target is not a member', async () => {
    prismaMock.group.findUnique.mockResolvedValue(groupWithOwnerSelect);
    prismaMock.groupMember.findUnique.mockResolvedValue(null);

    await expect(removeMember(group.id, owner.id, stranger.id)).rejects.toThrow(NotFoundError);
    await expect(removeMember(group.id, owner.id, stranger.id)).rejects.toThrow('errors.groups.memberNotFound');
  });
});

// ---------------------------------------------------------------------------
// removePendingInvite
// ---------------------------------------------------------------------------
describe('removePendingInvite', () => {
  it('removes pending invite as owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(group);
    prismaMock.pendingGroupInvite.deleteMany.mockResolvedValue({ count: 1 });

    await removePendingInvite(group.id, owner.id, 'pending@test.com');

    expect(prismaMock.pendingGroupInvite.deleteMany).toHaveBeenCalledWith({
      where: { groupId: group.id, email: 'pending@test.com' },
    });
  });

  it('throws ForbiddenError for non-owner', async () => {
    prismaMock.group.findUnique.mockResolvedValue(group);

    await expect(removePendingInvite(group.id, member.id, 'pending@test.com')).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// processPendingGroupInvites
// ---------------------------------------------------------------------------
describe('processPendingGroupInvites', () => {
  it('processes pending invites and creates members', async () => {
    const pendingInvite = {
      ...makePendingGroupInvite({ groupId: group.id, email: member.email }),
      group: {
        ...group,
        owner: { id: owner.id, name: owner.name, email: owner.email, locale: 'en' },
      },
    };
    prismaMock.pendingGroupInvite.findMany.mockResolvedValue([pendingInvite]);
    prismaMock.groupMember.findUnique.mockResolvedValue(null);
    prismaMock.groupMember.create.mockResolvedValue({});
    prismaMock.pendingGroupInvite.delete.mockResolvedValue({});

    await processPendingGroupInvites(member.id, member.email);

    expect(prismaMock.groupMember.create).toHaveBeenCalledWith({
      data: { groupId: group.id, userId: member.id },
    });
    // Notification to the new member
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      member.id,
      'GROUP_INVITE',
      'Added to Group',
      expect.stringContaining(group.name),
      expect.objectContaining({ groupId: group.id }),
    );
    // Notification to the group owner
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      owner.id,
      'SYSTEM',
      'Group Member Joined',
      expect.stringContaining(member.email),
      expect.objectContaining({ groupId: group.id, memberEmail: member.email }),
    );
    // Email to the group owner
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      owner.email,
      'GROUP_MEMBER_JOINED',
      expect.objectContaining({ groupName: group.name, memberEmail: member.email }),
    );
    // Clean up the pending invite
    expect(prismaMock.pendingGroupInvite.delete).toHaveBeenCalledWith({
      where: { id: pendingInvite.id },
    });
  });

  it('skips if no pending invites', async () => {
    prismaMock.pendingGroupInvite.findMany.mockResolvedValue([]);

    await processPendingGroupInvites(member.id, member.email);

    expect(prismaMock.groupMember.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it('skips creating member if already a member and cleans up invite', async () => {
    const pendingInvite = {
      ...makePendingGroupInvite({ groupId: group.id, email: member.email }),
      group: {
        ...group,
        owner: { id: owner.id, name: owner.name, email: owner.email, locale: 'en' },
      },
    };
    prismaMock.pendingGroupInvite.findMany.mockResolvedValue([pendingInvite]);
    prismaMock.groupMember.findUnique.mockResolvedValue(makeGroupMember({ groupId: group.id, userId: member.id }));
    prismaMock.pendingGroupInvite.delete.mockResolvedValue({});

    await processPendingGroupInvites(member.id, member.email);

    expect(prismaMock.groupMember.create).not.toHaveBeenCalled();
    expect(prismaMock.pendingGroupInvite.delete).toHaveBeenCalledWith({
      where: { id: pendingInvite.id },
    });
  });
});

// ---------------------------------------------------------------------------
// getGroupsForSharing
// ---------------------------------------------------------------------------
describe('getGroupsForSharing', () => {
  it('returns groups where user is owner or member', async () => {
    const groups = [{ ...group, members: [], _count: { members: 1 } }];
    prismaMock.group.findMany.mockResolvedValue(groups);

    const result = await getGroupsForSharing(owner.id);

    expect(result).toEqual(groups);
    expect(prismaMock.group.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { ownerId: owner.id },
          { members: { some: { userId: owner.id } } },
        ],
      },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } } },
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
  });
});

// ---------------------------------------------------------------------------
// hasPendingGroupInvite
// ---------------------------------------------------------------------------
describe('hasPendingGroupInvite', () => {
  it('returns true when there are pending invites', async () => {
    prismaMock.pendingGroupInvite.count.mockResolvedValue(2);

    const result = await hasPendingGroupInvite('pending@test.com');

    expect(result).toBe(true);
    expect(prismaMock.pendingGroupInvite.count).toHaveBeenCalledWith({ where: { email: 'pending@test.com' } });
  });

  it('returns false when there are no pending invites', async () => {
    prismaMock.pendingGroupInvite.count.mockResolvedValue(0);

    const result = await hasPendingGroupInvite('nobody@test.com');

    expect(result).toBe(false);
  });
});
