# Chat System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a WhatsApp-like chat system with 1:1 and group conversations, real-time WebSocket messaging, emoji reactions, file sharing, friend system (auto + manual), and network status indicator.

**Architecture:** Dedicated WebSocket server on `/chat-ws` (separate from Hocuspocus `/ws`). New Prisma models for friendships, conversations, messages, reactions, and chat files. Frontend chat page at `/chat` with contact list + conversation pane (WhatsApp layout). Online-only — requires network connection, with status indicator in app header. emoji-mart for emoji picker. Files stored in `uploads/chat/`.

**Tech Stack:** Prisma 7, Fastify 5, React 19, TailwindCSS 3, ws (WebSocket), emoji-mart, sharp (thumbnails)

---

## Data Model

```prisma
// ─── Friendship System ─────────────────────────────────────

enum FriendshipStatus {
  ACTIVE
  BLOCKED_BY_A    // userA blocked userB
  BLOCKED_BY_B    // userB blocked userA
}

enum FriendRequestStatus {
  PENDING
  ACCEPTED
  DECLINED
}

model Friendship {
  id        String           @id @default(uuid())
  userAId   String           // Alphabetically smaller ID always goes in userAId
  userA     User             @relation("FriendshipA", fields: [userAId], references: [id], onDelete: Cascade)
  userBId   String
  userB     User             @relation("FriendshipB", fields: [userBId], references: [id], onDelete: Cascade)
  status    FriendshipStatus @default(ACTIVE)
  createdAt DateTime         @default(now())

  @@unique([userAId, userBId])
  @@index([userAId])
  @@index([userBId])
}

model FriendRequest {
  id        String              @id @default(uuid())
  fromId    String
  from      User                @relation("FriendRequestsSent", fields: [fromId], references: [id], onDelete: Cascade)
  toId      String
  to        User                @relation("FriendRequestsReceived", fields: [toId], references: [id], onDelete: Cascade)
  status    FriendRequestStatus @default(PENDING)
  createdAt DateTime            @default(now())

  @@unique([fromId, toId])
  @@index([toId, status])
}

// ─── Conversations ──────────────────────────────────────────

enum ConversationType {
  DIRECT
  GROUP
}

model Conversation {
  id           String               @id @default(uuid())
  type         ConversationType
  title        String?              // Only for GROUP conversations
  avatarUrl    String?              // Only for GROUP conversations
  participants ConversationParticipant[]
  messages     DirectMessage[]
  createdAt    DateTime             @default(now())
  updatedAt    DateTime             @updatedAt

  @@index([updatedAt])
}

model ConversationParticipant {
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userId         String
  user           User         @relation("ChatParticipants", fields: [userId], references: [id], onDelete: Cascade)
  lastReadAt     DateTime     @default(now())
  joinedAt       DateTime     @default(now())

  @@id([conversationId, userId])
  @@index([userId])
}

// ─── Messages ───────────────────────────────────────────────

model DirectMessage {
  id             String             @id @default(uuid())
  conversationId String
  conversation   Conversation       @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  senderId       String
  sender         User               @relation("ChatMessagesSent", fields: [senderId], references: [id], onDelete: Cascade)
  content        String             // Text content (can be empty if file-only)
  replyToId      String?
  replyTo        DirectMessage?     @relation("MessageReplies", fields: [replyToId], references: [id], onDelete: SetNull)
  replies        DirectMessage[]    @relation("MessageReplies")
  reactions      MessageReaction[]
  files          ChatFile[]
  editedAt       DateTime?
  isDeleted      Boolean            @default(false)
  createdAt      DateTime           @default(now())

  @@index([conversationId, createdAt])
  @@index([senderId])
}

model MessageReaction {
  messageId String
  message   DirectMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  userId    String
  user      User          @relation("ChatReactions", fields: [userId], references: [id], onDelete: Cascade)
  emoji     String        // Unicode emoji character(s)
  createdAt DateTime      @default(now())

  @@id([messageId, userId])   // One reaction per user per message
}

model ChatFile {
  id           String        @id @default(uuid())
  messageId    String
  message      DirectMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  url          String        // /uploads/chat/{uuid}.{ext}
  thumbnailUrl String?       // /uploads/chat/thumbs/{uuid}.jpg
  filename     String        // Original filename
  mimeType     String
  size         Int           // Bytes
  createdAt    DateTime      @default(now())

  @@index([messageId])
}
```

**SystemSetting keys for admin config:**
- `chat_max_file_size_mb` — Default: `10` (admin-configurable)
- `chat_enabled` — Default: `true`

---

## WebSocket Architecture

### Server: `/chat-ws`

New WebSocket server in `backend/src/chatWebSocket.ts`, attached to Fastify server alongside Hocuspocus.

**Connection lifecycle:**
1. Client connects to `ws://host/chat-ws?token=JWT`
2. Server verifies JWT, extracts userId
3. Per-user connection tracking (like Hocuspocus pattern, max 10)
4. User marked as "online" in in-memory Map
5. Broadcast online status to all friends
6. On disconnect: mark offline, broadcast to friends

**Event protocol (JSON over WS):**

Client → Server:
```typescript
{ type: 'message:send', conversationId, content, replyToId?, tempId }
{ type: 'message:edit', messageId, content }
{ type: 'message:delete', messageId }
{ type: 'reaction:set', messageId, emoji }
{ type: 'reaction:remove', messageId }
{ type: 'typing:start', conversationId }
{ type: 'typing:stop', conversationId }
{ type: 'read:update', conversationId, lastReadAt }
```

Server → Client:
```typescript
{ type: 'message:new', message: DirectMessage }
{ type: 'message:edited', messageId, content, editedAt }
{ type: 'message:deleted', messageId }
{ type: 'reaction:updated', messageId, reactions: MessageReaction[] }
{ type: 'typing:indicator', conversationId, userId, isTyping }
{ type: 'read:receipt', conversationId, userId, lastReadAt }
{ type: 'presence:update', userId, isOnline }
{ type: 'message:ack', tempId, messageId }   // Confirm sent message
```

**Presence tracking:**
```typescript
const onlineUsers = new Map<string, Set<WebSocket>>();  // userId → active connections
```

**Typing indicator:**
- Client sends typing:start on keydown (debounced 1s)
- Client sends typing:stop on 3s idle or message sent
- Server forwards to other conversation participants

---

## File Structure

### Backend (create)
- `backend/src/chatWebSocket.ts` — WS server, auth, presence, message routing
- `backend/src/services/chat-direct.service.ts` — Message CRUD, reactions, read receipts
- `backend/src/services/friendship.service.ts` — Friend system (auto-create, requests, block)
- `backend/src/services/chat-file.service.ts` — File upload, thumbnail generation, validation
- `backend/src/routes/chat-direct.ts` — REST endpoints (history, search, file upload)
- `backend/src/routes/friendships.ts` — REST endpoints (list, request, block)

### Backend (modify)
- `backend/prisma/schema.prisma` — New models + enums + User relations
- `backend/src/app.ts` — Register routes + WS upgrade handler for `/chat-ws`
- `backend/src/services/sharing.service.ts` — Auto-create friendship on share accept
- `backend/src/services/admin.service.ts` — Chat KPIs for admin dashboard

### Frontend (create)
- `frontend/src/features/chat/ChatPage.tsx` — Main page (contact list + conversation)
- `frontend/src/features/chat/components/ConversationList.tsx` — Left pane: friend/group list
- `frontend/src/features/chat/components/ConversationView.tsx` — Right pane: message thread
- `frontend/src/features/chat/components/MessageBubble.tsx` — Single message with reactions
- `frontend/src/features/chat/components/MessageInput.tsx` — Input bar (text + emoji + file)
- `frontend/src/features/chat/components/EmojiPicker.tsx` — emoji-mart wrapper
- `frontend/src/features/chat/components/ReactionPicker.tsx` — WhatsApp long-press reaction selector
- `frontend/src/features/chat/components/TypingIndicator.tsx` — Animated dots
- `frontend/src/features/chat/components/ChatFilePreview.tsx` — File thumbnail/preview
- `frontend/src/features/chat/components/FriendRequestModal.tsx` — Send/manage friend requests
- `frontend/src/features/chat/components/GroupChatModal.tsx` — Create/manage group chat
- `frontend/src/features/chat/chatService.ts` — REST API calls
- `frontend/src/features/chat/useChatWebSocket.ts` — WS connection hook
- `frontend/src/features/chat/useChatPresence.ts` — Online status hook
- `frontend/src/components/layout/NetworkStatusIndicator.tsx` — Connection indicator in header

### Frontend (modify)
- `frontend/src/components/layout/AppLayout.tsx` — Add NetworkStatusIndicator
- `frontend/src/components/layout/Sidebar.tsx` — Add Chat nav item + unread badge
- `frontend/src/App.tsx` — Add /chat route
- `frontend/src/locales/en.json` + `it.json` — i18n keys
- `frontend/src/data/changelog.ts` — Version bump

---

## Implementation Phases

### SUB-PLAN A: Foundation (Tasks 1-6)
Database models, friendship service, basic message CRUD.

### SUB-PLAN B: WebSocket & Real-time (Tasks 7-11)
WS server, presence, typing, read receipts, message delivery.

### SUB-PLAN C: Frontend Chat UI (Tasks 12-19)
Chat page, conversation list, message view, input, emoji, reactions.

### SUB-PLAN D: File Sharing (Tasks 20-23)
Upload, thumbnails, preview, admin management.

### SUB-PLAN E: Friend System UI + Network Status (Tasks 24-28)
Friend requests, blocking, auto-friend on share, network indicator.

---

## SUB-PLAN A: Foundation (Tasks 1-6)

### Task 1: Prisma Schema + Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260327000000_add_chat_system/migration.sql`

- [ ] Add all enums: `FriendshipStatus`, `FriendRequestStatus`, `ConversationType`
- [ ] Add all models: `Friendship`, `FriendRequest`, `Conversation`, `ConversationParticipant`, `DirectMessage`, `MessageReaction`, `ChatFile`
- [ ] Add User relations:
  ```
  friendshipsA         Friendship[]              @relation("FriendshipA")
  friendshipsB         Friendship[]              @relation("FriendshipB")
  friendRequestsSent   FriendRequest[]            @relation("FriendRequestsSent")
  friendRequestsRecv   FriendRequest[]            @relation("FriendRequestsReceived")
  chatParticipations   ConversationParticipant[]  @relation("ChatParticipants")
  chatMessagesSent     DirectMessage[]            @relation("ChatMessagesSent")
  chatReactions        MessageReaction[]          @relation("ChatReactions")
  ```
- [ ] Add SystemSettings: `chat_max_file_size_mb` (10), `chat_enabled` (true)
- [ ] Write migration SQL, apply to dev DB, resolve, generate client
- [ ] Build: `npm run build`
- [ ] Commit

### Task 2: Friendship Service

**Files:**
- Create: `backend/src/services/friendship.service.ts`

Key design: `userAId` is always the alphabetically smaller UUID to enforce uniqueness without duplicate entries (A→B and B→A are the same friendship).

```typescript
// Helpers
function orderedIds(id1: string, id2: string): [string, string] {
  return id1 < id2 ? [id1, id2] : [id2, id1];
}

// Functions
getFriends(userId): User[] — All ACTIVE friendships for user
getFriendship(userId, friendId): Friendship | null
createFriendship(userId, friendId): Friendship — Used by auto-friend on share
sendFriendRequest(fromId, toId): FriendRequest
acceptFriendRequest(requestId, userId): Friendship
declineFriendRequest(requestId, userId): void
getPendingRequests(userId): FriendRequest[] — Incoming pending
getSentRequests(userId): FriendRequest[] — Outgoing pending
blockFriend(userId, friendId): void — Set BLOCKED_BY_A/B + delete messages
unblockFriend(userId, friendId): void
isBlocked(userId, friendId): boolean
getAutoFriendCandidates(userId): User[] — Users with shared items or common groups
```

Block logic:
```typescript
async blockFriend(userId, friendId) {
  const [userAId, userBId] = orderedIds(userId, friendId);
  const blockedBy = userId === userAId ? 'BLOCKED_BY_A' : 'BLOCKED_BY_B';

  await prisma.$transaction(async (tx) => {
    // Update friendship status
    await tx.friendship.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: { status: blockedBy },
      create: { userAId, userBId, status: blockedBy },
    });

    // Find DIRECT conversation between the two and delete all messages
    const conv = await tx.conversation.findFirst({
      where: {
        type: 'DIRECT',
        participants: { every: { userId: { in: [userId, friendId] } } },
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: friendId } } },
        ],
      },
    });
    if (conv) {
      await tx.directMessage.deleteMany({ where: { conversationId: conv.id } });
      // Keep conversation shell for potential unblock, or delete entirely
      await tx.conversation.delete({ where: { id: conv.id } });
    }
  });
}
```

- [ ] Implement all functions with orderedIds pattern
- [ ] Build: `npm run build`
- [ ] Commit

### Task 3: Chat Direct Service

**Files:**
- Create: `backend/src/services/chat-direct.service.ts`

```typescript
// Conversation management
getOrCreateDirectConversation(userId1, userId2): Conversation
createGroupConversation(creatorId, title, participantIds): Conversation
getConversations(userId): ConversationWithLastMessage[] — List with last message + unread count
getConversation(conversationId, userId): Conversation — Verify participant

// Messages
getMessages(conversationId, userId, { page, limit, before? }): DirectMessage[]
sendMessage(conversationId, senderId, { content, replyToId? }): DirectMessage
editMessage(messageId, senderId, content): DirectMessage — 5 min window check
deleteMessage(messageId, senderId): void — Last message only check
searchMessages(conversationId, userId, query): DirectMessage[]

// Read receipts
updateReadReceipt(conversationId, userId): void — Set lastReadAt = now()
getUnreadCount(userId): number — Total across all conversations

// Reactions
setReaction(messageId, userId, emoji): MessageReaction
removeReaction(messageId, userId): void
```

Edit validation:
```typescript
async editMessage(messageId, senderId, content) {
  const msg = await prisma.directMessage.findUnique({ where: { id: messageId } });
  if (!msg || msg.senderId !== senderId) throw new ForbiddenError('...');
  if (msg.isDeleted) throw new BadRequestError('...');

  const ageMs = Date.now() - msg.createdAt.getTime();
  if (ageMs > 5 * 60 * 1000) throw new BadRequestError('errors.chat.editWindowExpired');

  return prisma.directMessage.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
  });
}
```

Delete validation (last message only):
```typescript
async deleteMessage(messageId, senderId) {
  const msg = await prisma.directMessage.findUnique({ where: { id: messageId } });
  if (!msg || msg.senderId !== senderId) throw new ForbiddenError('...');

  // Check this is the last non-deleted message by this sender in this conversation
  const lastMsg = await prisma.directMessage.findFirst({
    where: { conversationId: msg.conversationId, senderId, isDeleted: false },
    orderBy: { createdAt: 'desc' },
  });
  if (!lastMsg || lastMsg.id !== messageId) {
    throw new BadRequestError('errors.chat.canOnlyDeleteLastMessage');
  }

  await prisma.directMessage.update({
    where: { id: messageId },
    data: { isDeleted: true, content: '' },
  });
}
```

- [ ] Implement all functions
- [ ] Build: `npm run build`
- [ ] Commit

### Task 4: Friendship Routes

**Files:**
- Create: `backend/src/routes/friendships.ts`

Endpoints:
- `GET /api/friends` — List friends (ACTIVE) with online status
- `GET /api/friends/requests` — Pending incoming requests
- `GET /api/friends/requests/sent` — Pending outgoing requests
- `POST /api/friends/request` — Send friend request `{ userId: string }`
- `POST /api/friends/request/:id/accept` — Accept
- `POST /api/friends/request/:id/decline` — Decline
- `POST /api/friends/:id/block` — Block friend
- `POST /api/friends/:id/unblock` — Unblock
- `GET /api/friends/suggestions` — Auto-friend candidates

Rate limit: 10/min on friend requests.

- [ ] Implement with Zod validation + authenticate hook
- [ ] Register in app.ts
- [ ] Build + commit

### Task 5: Chat Direct Routes

**Files:**
- Create: `backend/src/routes/chat-direct.ts`

Endpoints:
- `GET /api/chat/conversations` — List conversations with last message + unread
- `GET /api/chat/conversations/:id/messages?page=1&limit=50&before=` — Paginated messages
- `GET /api/chat/conversations/:id/search?q=` — Search within conversation
- `POST /api/chat/conversations/direct` — Get or create direct conversation `{ userId }`
- `POST /api/chat/conversations/group` — Create group `{ title, participantIds }`
- `GET /api/chat/unread` — Total unread count (for sidebar badge)

File upload (separate from WS — uses multipart):
- `POST /api/chat/conversations/:id/files` — Upload file(s) with optional message text

- [ ] Implement with Zod validation
- [ ] Register in app.ts
- [ ] Build + commit

### Task 6: Auto-Friend on Share Accept

**Files:**
- Modify: `backend/src/services/sharing.service.ts`

In the accept flow for notes, notebooks, task lists, and kanban boards — after setting status to ACCEPTED, auto-create friendship if not exists:

```typescript
import { createFriendship, getFriendship } from './friendship.service';

// After accepting share:
const existing = await getFriendship(share.note.userId, userId);
if (!existing) {
  await createFriendship(share.note.userId, userId);
}
```

Must be added in 4 places: acceptNoteShare, acceptNotebookShare, acceptTaskListShare, acceptKanbanBoardShare.

Also: when adding users to groups, auto-friend with all existing members.

- [ ] Add auto-friend calls in all accept flows
- [ ] Add auto-friend in group member addition
- [ ] Build + commit

---

## SUB-PLAN B: WebSocket & Real-time (Tasks 7-11)

### Task 7: Chat WebSocket Server

**Files:**
- Create: `backend/src/chatWebSocket.ts`
- Modify: `backend/src/app.ts` — Add WS upgrade for `/chat-ws`

WS Server architecture:
```typescript
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';

const chatWss = new WebSocketServer({ noServer: true });

// State
const userConnections = new Map<string, Set<WebSocket>>();
const MAX_CHAT_WS_PER_USER = 5;

// Auth on upgrade
function authenticateWs(request): Promise<string> { ... }

// Connection handler
chatWss.on('connection', (ws, userId) => {
  // Track connection
  // Set up message handler (parse JSON, route to handler)
  // Set up close handler (cleanup, broadcast offline)
  // Heartbeat ping/pong every 30s
});

// Message router
function handleMessage(ws, userId, data) {
  switch (data.type) {
    case 'message:send': handleSendMessage(ws, userId, data); break;
    case 'message:edit': handleEditMessage(ws, userId, data); break;
    case 'message:delete': handleDeleteMessage(ws, userId, data); break;
    case 'reaction:set': handleSetReaction(ws, userId, data); break;
    case 'reaction:remove': handleRemoveReaction(ws, userId, data); break;
    case 'typing:start': handleTyping(userId, data, true); break;
    case 'typing:stop': handleTyping(userId, data, false); break;
    case 'read:update': handleReadUpdate(userId, data); break;
  }
}

// Broadcast to conversation participants
function broadcastToConversation(conversationId, event, excludeUserId?) { ... }

// Broadcast to specific user (all connections)
function broadcastToUser(userId, event) { ... }

// Presence helpers
function isUserOnline(userId): boolean { ... }
function getOnlineFriends(userId): string[] { ... }

export { chatWss, isUserOnline, broadcastToUser, broadcastToConversation };
```

Attach in app.ts:
```typescript
import { chatWss } from './chatWebSocket';

server.server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws' || request.url?.startsWith('/ws?')) {
    // Existing Hocuspocus handler
  } else if (request.url === '/chat-ws' || request.url?.startsWith('/chat-ws?')) {
    chatWss.handleUpgrade(request, socket, head, (ws) => {
      chatWss.emit('connection', ws, request);
    });
  }
});
```

- [ ] Implement chatWebSocket.ts with auth, presence, heartbeat, message routing
- [ ] Attach to app.ts upgrade handler
- [ ] Build + commit

### Task 8: Message Send/Receive via WS

**Files:**
- Modify: `backend/src/chatWebSocket.ts`

Handle `message:send`:
1. Validate: user is participant of conversation, content not empty, friendship not blocked
2. Create DirectMessage in DB via chat-direct.service
3. Update conversation.updatedAt
4. Send `message:ack` back to sender (with DB-assigned messageId)
5. Broadcast `message:new` to all other conversation participants
6. For offline participants: create Notification + push

Handle `message:edit`:
1. Call editMessage service (validates 5-min window)
2. Broadcast `message:edited` to conversation

Handle `message:delete`:
1. Call deleteMessage service (validates last-message rule)
2. Broadcast `message:deleted` to conversation

- [ ] Implement all three handlers
- [ ] Build + commit

### Task 9: Typing Indicator via WS

**Files:**
- Modify: `backend/src/chatWebSocket.ts`

Simple relay — no DB persistence:
```typescript
function handleTyping(userId, data, isTyping) {
  broadcastToConversation(data.conversationId, {
    type: 'typing:indicator',
    conversationId: data.conversationId,
    userId,
    isTyping,
  }, userId); // Exclude sender
}
```

Client-side debounce:
- Send `typing:start` on first keypress
- Clear typing after 3s of no input or after message sent
- Don't re-send `typing:start` if already typing

- [ ] Implement typing relay
- [ ] Build + commit

### Task 10: Read Receipts via WS

**Files:**
- Modify: `backend/src/chatWebSocket.ts`

Handle `read:update`:
1. Update ConversationParticipant.lastReadAt in DB
2. Broadcast `read:receipt` to all other participants

Frontend uses lastReadAt per participant to show:
- Single check ✓ = delivered
- Double blue check ✓✓ = read (for DIRECT: other user's lastReadAt >= message.createdAt)
- For GROUP: show "read by N" count

- [ ] Implement read receipt handler
- [ ] Build + commit

### Task 11: Presence Broadcasting

**Files:**
- Modify: `backend/src/chatWebSocket.ts`

On connect:
1. Add to userConnections
2. Get user's friends list
3. Broadcast `presence:update { userId, isOnline: true }` to online friends
4. Send current online friends list to newly connected user

On disconnect (last connection):
1. Remove from userConnections
2. Broadcast `presence:update { userId, isOnline: false }` to online friends

- [ ] Implement presence on connect/disconnect
- [ ] Build + commit

---

## SUB-PLAN C: Frontend Chat UI (Tasks 12-19)

### Task 12: Chat Service + Types

**Files:**
- Create: `frontend/src/features/chat/chatService.ts`

TypeScript interfaces + API functions:
```typescript
interface ChatUser { id: string; name: string; email: string; avatarUrl: string | null; color: string; isOnline?: boolean; }
interface ConversationSummary { id: string; type: 'DIRECT' | 'GROUP'; title: string | null; avatarUrl: string | null; lastMessage: MessagePreview | null; unreadCount: number; participants: ChatUser[]; updatedAt: string; }
interface DirectMessageDTO { id: string; senderId: string; sender: ChatUser; content: string; replyTo: { id: string; content: string; sender: ChatUser } | null; reactions: { emoji: string; userId: string; user: ChatUser }[]; files: ChatFileDTO[]; editedAt: string | null; isDeleted: boolean; createdAt: string; }
interface ChatFileDTO { id: string; url: string; thumbnailUrl: string | null; filename: string; mimeType: string; size: number; }

// API functions
getConversations(): ConversationSummary[]
getMessages(conversationId, page, before?): DirectMessageDTO[]
getOrCreateDirectConversation(userId): Conversation
createGroupConversation(title, participantIds): Conversation
searchMessages(conversationId, query): DirectMessageDTO[]
getUnreadCount(): number
uploadChatFile(conversationId, file: File, message?: string): DirectMessageDTO
```

- [ ] Implement types and API service
- [ ] Type-check
- [ ] Commit

### Task 13: Chat WebSocket Hook

**Files:**
- Create: `frontend/src/features/chat/useChatWebSocket.ts`

Custom hook managing WS connection:
```typescript
function useChatWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handlers = useRef(new Map<string, Set<Function>>());

  // Connect with JWT token
  // Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
  // Heartbeat pong response
  // Message parsing and event dispatch to handlers

  const send = (event: ChatWsEvent) => { ... };
  const on = (type: string, handler: Function) => { ... };
  const off = (type: string, handler: Function) => { ... };

  return { isConnected, send, on, off };
}
```

- [ ] Implement with reconnection, heartbeat, event bus
- [ ] Type-check
- [ ] Commit

### Task 14: Network Status Indicator

**Files:**
- Create: `frontend/src/components/layout/NetworkStatusIndicator.tsx`
- Modify: `frontend/src/components/layout/AppLayout.tsx`

Component:
- Uses `navigator.onLine` + `online`/`offline` events
- Also uses WS connection state from chat hook
- Shows in header/taskbar:
  - Green dot = online + WS connected
  - Yellow dot = online but WS reconnecting
  - Red dot + "Offline" text = no network
- Mobile: compact, just dot. Desktop: dot + text

- [ ] Implement component with online/offline detection
- [ ] Add to AppLayout header area
- [ ] Commit

### Task 15: ChatPage + ConversationList

**Files:**
- Create: `frontend/src/features/chat/ChatPage.tsx`
- Create: `frontend/src/features/chat/components/ConversationList.tsx`
- Modify: `frontend/src/App.tsx` — Add route
- Modify: `frontend/src/components/layout/Sidebar.tsx` — Add nav item

ChatPage layout (WhatsApp):
```tsx
// Desktop: side-by-side
<div className="flex h-full">
  <ConversationList className="w-80 border-r" />
  <ConversationView className="flex-1" />
</div>

// Mobile: conditional render
{selectedConversation ? <ConversationView /> : <ConversationList />}
```

ConversationList:
- Search bar at top
- "New chat" button (→ friend list picker)
- Friend request badge/button
- Conversation items: avatar, name, last message preview, time, unread badge
- Online indicator (green dot on avatar)
- Sort by updatedAt DESC

Sidebar nav item:
```typescript
{ icon: MessageCircle, label: t('chat.title'), path: '/chat', count: totalUnreadCount }
```

- [ ] Implement ChatPage with responsive layout
- [ ] Implement ConversationList
- [ ] Add route + sidebar item
- [ ] Commit

### Task 16: ConversationView + MessageBubble

**Files:**
- Create: `frontend/src/features/chat/components/ConversationView.tsx`
- Create: `frontend/src/features/chat/components/MessageBubble.tsx`

ConversationView:
- Header: avatar, name, online status, back button (mobile)
- Message list: scrollable, auto-scroll to bottom, load more on scroll up
- Messages grouped by date (separator: "Today", "Yesterday", date)
- Read receipt indicators (✓ sent, ✓✓ read in blue)

MessageBubble:
- Sender's messages: right-aligned, emerald background
- Others' messages: left-aligned, neutral background
- Reply quote block (if replying to a message)
- File previews inline
- Reactions bar below message
- Long-press (mobile) or hover (desktop) → context menu: Reply, React, Edit (if own, <5min), Delete (if own, last msg), Copy
- "Edited" indicator
- "Deleted" message placeholder
- Time stamp

- [ ] Implement ConversationView with infinite scroll, date separators, read receipts
- [ ] Implement MessageBubble with all states (sent, received, edited, deleted, with files, with reactions, with reply)
- [ ] Commit

### Task 17: MessageInput

**Files:**
- Create: `frontend/src/features/chat/components/MessageInput.tsx`

Input bar:
- Multiline text input (auto-grow, max 6 lines)
- Emoji button → opens emoji-mart picker (positioned above input)
- Attachment button → file picker (with executable filter)
- Send button (or Enter to send, Shift+Enter for newline)
- Reply preview bar (when replying to a message, shows quoted content + close button)
- File preview strip (when file selected, shows thumb + name + remove button)
- Typing indicator integration (send WS events on input)

Chat disabled state when offline (gray out input, show "You're offline" message)

- [ ] Implement input with emoji, file attachment, reply preview
- [ ] Install emoji-mart: `npm install @emoji-mart/react @emoji-mart/data`
- [ ] Commit

### Task 18: EmojiPicker + ReactionPicker

**Files:**
- Create: `frontend/src/features/chat/components/EmojiPicker.tsx`
- Create: `frontend/src/features/chat/components/ReactionPicker.tsx`

EmojiPicker:
- Wrapper around emoji-mart's `Picker` component
- Positioned above input (portal)
- Theme-aware (dark mode)
- Closes on selection or outside click

ReactionPicker (WhatsApp long-press style):
- Shows on long-press (mobile) or hover+click (desktop) on a message
- Quick reaction row: 👍 ❤️ 😂 😮 😢 🙏 (6 defaults)
- "+" button to open full emoji picker
- One reaction per user (selecting a new one replaces the old)
- Clicking own reaction removes it

- [ ] Implement both pickers
- [ ] Commit

### Task 19: TypingIndicator + Search

**Files:**
- Create: `frontend/src/features/chat/components/TypingIndicator.tsx`

TypingIndicator:
- Three animated dots (WhatsApp style)
- Shows "UserName" text in group chats
- Positioned below last message or in input area
- CSS-only animation (transform + opacity on dots)

Search:
- Search icon in ConversationView header
- Expands to search input
- Results highlighted in message list (scroll to match)
- Uses `GET /chat/conversations/:id/search?q=`

- [ ] Implement TypingIndicator with CSS animation
- [ ] Implement search within conversation
- [ ] Commit

---

## SUB-PLAN D: File Sharing (Tasks 20-23)

### Task 20: Chat File Service (Backend)

**Files:**
- Create: `backend/src/services/chat-file.service.ts`

```typescript
const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.com', '.msi', '.scr', '.pif'];
const CHAT_UPLOADS_DIR = path.join(__dirname, '../../uploads/chat');
const CHAT_THUMBS_DIR = path.join(CHAT_UPLOADS_DIR, 'thumbs');

async uploadChatFile(conversationId, senderId, file): ChatFile
  // 1. Validate: extension not blocked, size within admin limit (SystemSetting chat_max_file_size_mb)
  // 2. Stream to uploads/chat/{uuid}.{ext}
  // 3. If image: generate thumbnail (sharp, 200x200) to uploads/chat/thumbs/{uuid}.jpg
  // 4. Create ChatFile record linked to message
  // 5. Return ChatFile with URLs

async deleteChatFile(fileId): void  // Admin only
async getChatStorageStats(): { totalFiles, totalSizeMB, filesByType }  // Admin KPI
```

- [ ] Implement file service with validation, thumbnail generation
- [ ] Create uploads/chat and uploads/chat/thumbs directories
- [ ] Add file serving route in app.ts for /uploads/chat/*
- [ ] Commit

### Task 21: Chat File Upload Route

**Files:**
- Modify: `backend/src/routes/chat-direct.ts`

`POST /api/chat/conversations/:id/files`:
- Multipart upload
- Verify user is conversation participant
- Process file via chat-file.service
- Create DirectMessage with file attachment
- Broadcast via WS

- [ ] Implement upload endpoint
- [ ] Build + commit

### Task 22: ChatFilePreview Component

**Files:**
- Create: `frontend/src/features/chat/components/ChatFilePreview.tsx`

Renders based on mimeType:
- Images: inline preview (thumbnail, click to expand)
- PDF: icon + filename + size
- Video: thumbnail with play icon
- Audio: compact audio player
- Other: file icon + filename + size + download button

All: download link, file size display

- [ ] Implement with type-based rendering
- [ ] Commit

### Task 23: Admin Chat File Management

**Files:**
- Create: `frontend/src/features/admin/tabs/ChatFilesTab.tsx`
- Modify: `frontend/src/features/admin/AdminPage.tsx` — Add tab

Admin page:
- KPIs: total files, total size, files by type (pie chart)
- File list: sortable by size, date, type
- Search by filename
- Delete action (with confirmation)
- Pagination

Backend: Add admin routes for listing/deleting chat files.

- [ ] Implement ChatFilesTab
- [ ] Add admin routes
- [ ] Commit

---

## SUB-PLAN E: Friend System UI + Network Status (Tasks 24-28)

### Task 24: FriendRequestModal

**Files:**
- Create: `frontend/src/features/chat/components/FriendRequestModal.tsx`

Modal to:
- Search users by name/email
- Send friend request
- Show pending incoming requests (accept/decline)
- Show sent requests (cancel)

Accessible from ConversationList "Add friend" button.

- [ ] Implement modal with user search + request management
- [ ] Commit

### Task 25: GroupChatModal

**Files:**
- Create: `frontend/src/features/chat/components/GroupChatModal.tsx`

Modal to:
- Set group name
- Select participants from friends list (checkbox multi-select)
- Create group
- Later: manage group (add/remove members, change title, set avatar)

- [ ] Implement modal
- [ ] Commit

### Task 26: Block/Unblock Flow

**Files:**
- Modify: `frontend/src/features/chat/components/ConversationList.tsx`
- Modify: `frontend/src/features/chat/components/ConversationView.tsx`

- Context menu on conversation: "Block user" option (with ConfirmDialog)
- Block calls `POST /api/friends/:id/block`
- Blocked conversation disappears from list
- Unblock from Settings or profile

- [ ] Implement block UI
- [ ] Commit

### Task 27: i18n + Changelog

**Files:**
- Modify: `frontend/src/locales/en.json` + `it.json`
- Modify: `frontend/src/data/changelog.ts`

All chat-related i18n keys (~60-80 keys):
- chat.title, chat.newChat, chat.newGroup, chat.searchPlaceholder
- chat.messagePlaceholder, chat.typing, chat.online, chat.offline
- chat.edited, chat.deleted, chat.editWindowExpired, chat.canOnlyDeleteLastMessage
- chat.fileTooBig, chat.blockedFileType, chat.reply, chat.react, chat.copy
- chat.block, chat.unblock, chat.blockConfirm
- friends.title, friends.request, friends.pending, friends.sent, friends.accept, friends.decline
- friends.suggestions, friends.noFriends, friends.blocked
- network.online, network.offline, network.reconnecting

- [ ] Add all i18n keys to both locales
- [ ] Add changelog entry
- [ ] Commit

### Task 28: Final Integration + Polish

- [ ] Full build test (backend + frontend)
- [ ] Verify chat disabled when offline
- [ ] Verify emoji picker in dark mode
- [ ] Verify mobile layout (list → chat → back)
- [ ] Verify file upload with thumbnail
- [ ] Verify read receipts + typing indicator
- [ ] Verify friend auto-creation on share accept
- [ ] Verify block removes chat history
- [ ] Verify admin can manage chat files
- [ ] Version bump + commit
