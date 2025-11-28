<div align="center">

<img src="frontend/public/pwa-512x512.png" alt="Notiq Logo" width="120" height="120" />

# Notiq

### ✨ Your thoughts, beautifully organized ✨

**A modern, offline-first note-taking PWA with real-time sync, secure vault, and collaborative sharing**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://reactjs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=flat-square&logo=fastify&logoColor=white)](https://www.fastify.io/)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![TailwindCSS](https://img.shields.io/badge/Tailwind-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)

<br />

[🚀 Features](#-features) • [🛠️ Tech Stack](#️-tech-stack) • [📦 Installation](#-installation) • [📖 API Reference](#-api-reference) • [🔐 Security](#-security)

<br />

<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="rainbow line" />

</div>

<br />

## 🌟 Why Notiq?

Notiq is not just another note-taking app. It's a **privacy-focused**, **offline-first** PWA designed for users who demand:

- 📴 **True offline capability** — Work without internet, sync when connected
- 🔒 **Secure Vault** — PIN-protected encrypted notes for sensitive information  
- 🎨 **Beautiful rich-text editing** — Font selection, formatting, tables, and more
- 🌍 **Multi-language support** — English and Italian out of the box
- 🌙 **Dark mode** — Easy on the eyes, day or night

<br />

## ✨ Features

<table>
<tr>
<td width="50%">

### 📝 Note Management
- **Rich Text Editor** with TipTap
- Font family selection (Arial, Times New Roman, Courier New, Georgia, Verdana)
- Headings, lists, blockquotes, code blocks
- Tables with resize support
- Links and text alignment
- Drag & drop file attachments
- Attachment badge counter

</td>
<td width="50%">

### 📓 Organization
- **Notebooks** — Group related notes together
- **Tags** — Flexible tagging system with quick search
- **Pinned Notes** — Quick access to favorites
- **Trash** — Soft delete with restore option
- **Smart Search** — Full-text search across all content

</td>
</tr>
<tr>
<td width="50%">

### 🔐 Security & Privacy
- **Secure Vault** — PIN-protected area for sensitive notes
- **PIN Warning** — Clear warnings about non-recoverable PIN
- **Destructive Reset** — Safe vault reset with confirmation
- JWT-based authentication
- Password hashing with bcrypt

</td>
<td width="50%">

### 🤝 Collaboration & Sharing
- **Public Links** — Share notes via read-only links
- **User Sharing** — Share with specific users (READ/WRITE)
- **Notebook Sharing** — Share entire notebooks
- **Shared With Me** — View all shared content

</td>
</tr>
<tr>
<td width="50%">

### ⏰ Tasks & Reminders
- **Inline Checkboxes** — Todo lists in notes
- **Reminders** — Date & time based notifications
- **Task View** — Unified view of all tasks
- Overdue, Today, Upcoming categories

</td>
<td width="50%">

### 📱 Progressive Web App
- **Installable** — Add to home screen
- **Offline Mode** — Full functionality without internet
- **Background Sync** — Auto-sync when connected
- **Responsive** — Desktop, tablet, mobile

</td>
</tr>
</table>

<br />

## 🎨 UI Highlights

| Feature | Description |
|---------|-------------|
| 🌙 **Dark Mode** | Full dark theme support across all components including search modal |
| 🔍 **Command Palette** | Quick search with `Ctrl+K` / `Cmd+K` |
| 🌐 **i18n** | Complete English and Italian translations |
| 🏷️ **Tag Selector** | Portal-based dropdown that works anywhere |
| 📎 **Attachment Badge** | Visual indicator of attachment count |

<br />

## 🛠️ Tech Stack

<table>
<tr>
<td align="center" width="33%">

### Frontend

![React](https://img.shields.io/badge/-React_19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/-Vite_7-646CFF?style=flat-square&logo=vite&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/-TailwindCSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)

- **TipTap** — Rich text editor
- **Zustand** — State management
- **TanStack Query** — Server state
- **Dexie.js** — IndexedDB for offline
- **React Router v7** — Routing
- **i18next** — Internationalization
- **cmdk** — Command palette

</td>
<td align="center" width="33%">

### Backend

![Node.js](https://img.shields.io/badge/-Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Fastify](https://img.shields.io/badge/-Fastify-000000?style=flat-square&logo=fastify&logoColor=white)
![Prisma](https://img.shields.io/badge/-Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)

- **JWT** — Authentication
- **Nodemailer** — Email service
- **Multipart** — File uploads
- **Zod** — Schema validation
- **bcrypt** — Password hashing

</td>
<td align="center" width="33%">

### DevOps & Testing

![Docker](https://img.shields.io/badge/-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Playwright](https://img.shields.io/badge/-Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)
![ESLint](https://img.shields.io/badge/-ESLint-4B32C3?style=flat-square&logo=eslint&logoColor=white)

- **19 E2E Tests** — Full coverage
- **Docker Compose** — Easy deployment
- **Hot Reload** — Fast development

</td>
</tr>
</table>

<br />

## 📦 Installation

### Prerequisites

- **Node.js** 18+ 
- **PostgreSQL** or SQLite
- **npm** or **yarn**

### Quick Start

```bash
# Clone the repository
git clone https://github.com/GitBakko/Notiq.git
cd Notiq

# Backend setup
cd backend
npm install
cp config.json.example config.json  # Configure SMTP settings
npx prisma migrate dev
npx prisma generate

# Frontend setup
cd ../frontend
npm install

# Run both (in separate terminals)
cd backend && npm run dev    # → http://localhost:3001
cd frontend && npm run dev   # → http://localhost:5173
```

### Environment Configuration

**Backend** (`backend/.env`):
```env
DATABASE_URL="postgresql://user:password@localhost:5432/notiq"
JWT_SECRET="your-super-secret-key"
```

**SMTP** (`backend/config.json`):
```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "user": "your@email.com",
    "pass": "your-password",
    "secure": false
  }
}
```

### 🧪 Testing SMTP Configuration

```bash
cd backend
npx ts-node src/scripts/testSmtp.ts your@email.com
```

<br />

## 📖 API Reference

### Authentication
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Login and receive JWT |
| `POST` | `/api/auth/forgot-password` | Request password reset |
| `POST` | `/api/auth/reset-password` | Reset password with token |

### Notes
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/api/notes` | List notes (with filters) |
| `GET` | `/api/notes/:id` | Get single note |
| `POST` | `/api/notes` | Create note |
| `PUT` | `/api/notes/:id` | Update note |
| `DELETE` | `/api/notes/:id` | Soft delete note |
| `POST` | `/api/notes/:id/share` | Share with user |

### Notebooks
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/api/notebooks` | List notebooks |
| `POST` | `/api/notebooks` | Create notebook |
| `PUT` | `/api/notebooks/:id` | Update notebook |
| `DELETE` | `/api/notebooks/:id` | Delete notebook |

### Tags
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/api/tags` | List all tags |
| `POST` | `/api/tags` | Create tag |
| `DELETE` | `/api/tags/:id` | Delete tag |
| `POST` | `/api/tags/:id/notes/:noteId` | Add tag to note |
| `DELETE` | `/api/tags/:id/notes/:noteId` | Remove tag from note |

### Attachments
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `POST` | `/api/attachments?noteId=` | Upload file |
| `GET` | `/api/attachments/:noteId` | List attachments |
| `DELETE` | `/api/attachments/:id` | Delete attachment |

### Sharing
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/api/share/notes` | Notes shared with me |
| `GET` | `/api/share/notebooks` | Notebooks shared with me |
| `DELETE` | `/api/share/notes/:noteId/:userId` | Revoke note access |

### User
| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/api/user/profile` | Get profile |
| `PUT` | `/api/user/profile` | Update profile |
| `PUT` | `/api/user/password` | Change password |
| `POST` | `/api/user/avatar` | Upload avatar |

<br />

## 📁 Project Structure

```
Notiq/
├── 🔧 backend/
│   ├── prisma/
│   │   ├── schema.prisma        # Database models
│   │   └── migrations/          # DB migrations
│   ├── src/
│   │   ├── routes/              # API endpoints
│   │   ├── services/            # Business logic
│   │   ├── plugins/             # Fastify plugins
│   │   ├── scripts/             # Utility scripts (SMTP test)
│   │   └── app.ts               # Server entry
│   ├── uploads/                 # User files (gitignored)
│   └── config.json              # SMTP configuration
│
├── 🎨 frontend/
│   ├── public/                  # PWA assets & icons
│   ├── src/
│   │   ├── components/
│   │   │   ├── editor/          # TipTap editor components
│   │   │   ├── layout/          # Sidebar, headers
│   │   │   ├── search/          # Command palette
│   │   │   ├── sharing/         # Share modals
│   │   │   └── ui/              # Buttons, dialogs, inputs
│   │   ├── features/
│   │   │   ├── auth/            # Login, register, forgot password
│   │   │   ├── notes/           # Note editor, list
│   │   │   ├── notebooks/       # Notebook management
│   │   │   ├── tags/            # Tag system
│   │   │   ├── vault/           # Secure vault
│   │   │   ├── tasks/           # Reminders & tasks
│   │   │   ├── trash/           # Deleted notes
│   │   │   └── sync/            # Offline sync
│   │   ├── store/               # Zustand stores
│   │   ├── hooks/               # Custom React hooks
│   │   ├── locales/             # i18n translations (en, it)
│   │   └── lib/                 # Utilities
│   └── e2e/                     # Playwright tests
│
└── 📋 docker-compose.yml        # Container orchestration
```

<br />

## 🔐 Security

| Feature | Implementation |
|---------|----------------|
| **Authentication** | JWT tokens with secure httpOnly cookies option |
| **Password Storage** | bcrypt with salt rounds |
| **Vault Encryption** | Client-side PIN hashing, encrypted note content |
| **CORS** | Configurable origin whitelist |
| **Input Validation** | Zod schemas on all endpoints |
| **SQL Injection** | Prisma parameterized queries |

<br />

## 🧪 Testing

```bash
# Run all E2E tests
cd frontend
npx playwright test

# Run with UI
npx playwright test --ui

# View test report
npx playwright show-report
```

**Test Coverage**: 18 tests covering auth, notes, notebooks, tags, sharing, search, tasks, and trash functionality.

<br />

## 🚀 Roadmap

| Status | Feature |
|:------:|---------|
| ✅ | Core note-taking with rich text |
| ✅ | Notebooks & Tags organization |
| ✅ | Secure Vault with PIN |
| ✅ | Dark mode & i18n |
| ✅ | Sharing & collaboration |
| ✅ | Tasks & reminders |
| ✅ | Offline-first with sync |
| ✅ | Font selection in editor |
| ✅ | Real-time collaborative editing |
| ✅ | Speech-to-Text (Dictation & Voice Memos) |
| ✅ | Advanced Table Tools |
| 🔜 | PDF/Markdown export |
| 🔜 | Mobile app (React Native) |
| 🔜 | AI-powered note suggestions |

<br />

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

<br />

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

<br />

---

<div align="center">

**Built with 💚 and TypeScript**

<sub>Made by [GitBakko](https://github.com/GitBakko)</sub>

<br />

⭐ **Star this repo** if you find it useful!

</div>
