# API Module

Server communication module for Aha CLI, handling authentication, encryption, and real-time updates.

## Overview

The `aha-cli/src/api` module provides the core infrastructure for communicating with the Aha server, including:

- **Session Management**: Create, update, and manage Claude Code sessions
- **Machine Registration**: Register and track machine state
- **End-to-End Encryption**: Secure communication using TweetNaCl and AES-256-GCM
- **Real-time Updates**: WebSocket-based live updates
- **RPC System**: Bidirectional remote procedure calls

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      aha-cli/src/api                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  ApiClient  │  │ ApiSession   │  │  ApiMachine      │   │
│  │             │  │   Client     │  │    Client        │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│         │                │                    │              │
│         └────────────────┼────────────────────┘              │
│                          ▼                                   │
│              ┌─────────────────────┐                        │
│              │    Encryption        │                        │
│              │  (TweetNaCl/AES)     │                        │
│              └─────────────────────┘                        │
│                          │                                   │
│              ┌───────────┴───────────┐                      │
│              ▼                       ▼                       │
│  ┌───────────────────┐   ┌────────────────────┐            │
│  │  WebSocket        │   │   REST API         │            │
│  │  (real-time)      │   │   (HTTP)           │            │
│  └───────────────────┘   └────────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### Core Classes

| Class | File | Purpose |
|-------|------|---------|
| `ApiClient` | `api.ts` | Main client for server communication, session/machine CRUD |
| `ApiSessionClient` | `apiSession.ts` | Session-scoped WebSocket client for real-time updates |
| `ApiMachineClient` | `apiMachine.ts` | Machine state management client |
| `PushNotificationClient` | `pushNotifications.ts` | Push notification delivery |

### Encryption

| Function | Algorithm | Use Case |
|----------|-----------|----------|
| `encryptLegacy` / `decryptLegacy` | TweetNaCl secretbox | Legacy session encryption |
| `encryptWithDataKey` / `decryptWithDataKey` | AES-256-GCM | Modern data encryption |
| `libsodiumEncryptForPublicKey` | TweetNaCl box | Asymmetric encryption |
| `libsodiumDecryptWithSecretKey` | TweetNaCl box | Asymmetric decryption |

### Types

All types are defined in `types.ts` using Zod schemas for runtime validation:

- **Session**: Claude Code session with encrypted metadata
- **Machine**: Registered machine with metadata and daemon state
- **Message**: Encrypted messages between client and server
- **Update**: Real-time update events from server
- **Artifact**: Code artifacts with versioned encrypted content

## Encryption Variants

### Legacy Mode
- Uses `tweetnacl.secretbox` for symmetric encryption
- Single shared secret key

### DataKey Mode (Recommended)
- Uses `AES-256-GCM` for data encryption
- Per-session random data keys
- Data keys encrypted with `tweetnacl.box` (asymmetric)

## API Endpoints

The module communicates with these server endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/sessions` | POST | Create new session |
| `/v1/sessions/:id` | GET | Get session |
| `/v1/machines` | POST | Register machine |
| `/v1/machines/:id` | GET | Get machine |
| `/v1/updates` | WebSocket | Real-time updates |

## Usage

```typescript
import { ApiClient } from '@/api/api'

// Create API client
const client = await ApiClient.create(credentials)

// Create or get session
const session = await client.getOrCreateSession({
  tag: 'my-session',
  metadata: { path: '/project', host: 'localhost' },
  state: null
})

// Get session client for real-time updates
const sessionClient = new ApiSessionClient(token, session)
sessionClient.on('message', (msg) => {
  console.log('Received:', msg)
})
await sessionClient.connect()
```

## Files

| File | Lines | Description |
|------|-------|-------------|
| `api.ts` | ~1350 | Main API client |
| `apiSession.ts` | ~450 | Session WebSocket client |
| `apiMachine.ts` | ~300 | Machine client |
| `encryption.ts` | ~244 | Encryption utilities |
| `types.ts` | ~460 | Zod schemas and types |
| `pushNotifications.ts` | ~180 | Push notifications |
| `auth.ts` | ~60 | Authentication |
| `webAuth.ts` | ~20 | Web authentication |
| `rpc/` | ~200 | RPC handler system |
