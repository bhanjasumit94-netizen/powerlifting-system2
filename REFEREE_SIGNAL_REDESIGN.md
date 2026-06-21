# Referee Signal System - Clean Architecture Redesign

## Overview

The referee signal system has been redesigned with a focus on session management, reliable signal delivery, and permanent audit trails. The new architecture separates concerns, improves error recovery, and provides clear visual feedback at each stage.

## Key Improvements

### 1. Session Management

**Problem Solved:** Old URLs for referee signals could be reused across competitions, causing confusion and potential signal mixing.

**Solution:** Each competition now generates unique session tokens that expire after 24 hours. Old sessions can be invalidated with a single "Refresh Session" button click.

**How It Works:**
- Referee coordinator creates a new session via "Create New Session" button
- Each session generates a unique UUID token
- Session links include: `/#/signals/{position}?session={sessionId}&cid={competitionId}`
- Sessions automatically expire after 24 hours
- "Refresh Session" invalidates all active sessions, forcing new links to be generated

**User Experience:**
- Referees see an error if accessing an expired/invalid session
- Clicking the error provides options to reload or close the window
- Session data is stored permanently in the database for audit purposes

### 2. Signal Data Architecture

**Problem Solved:** Signals were deleted immediately after display, making it impossible to recover if something went wrong.

**Solution:** Two-table system with temporary and permanent storage:

```
┌─────────────────────────────────────────┐
│   referee_signals (temporary)           │
│   - Stores current active signals       │
│   - Deleted after animation completes   │
│   - Used for real-time display sync     │
├─────────────────────────────────────────┤
│   signal_history (permanent)            │
│   - Stores all submitted signals        │
│   - Kept indefinitely for audit trail   │
│   - Records submission and delivery time│
└─────────────────────────────────────────┘
```

**Data Flow:**

1. **Signal Submission** (Referee Station):
   - Referee holds button for 1 second
   - Signal saved to `referee_signals` table (temporary)
   - Signal also saved to `signal_history` table (permanent with session_id)

2. **Signal Display** (Result Screen):
   - Real-time Supabase subscription monitors `referee_signals`
   - Visual indicator shown for each referee position
   - Counter shows "Waiting for: X more signals"

3. **Decision & Animation**:
   - When all 3 signals received: animation plays (2-4 seconds)
   - After animation: signals marked as "delivered" in history
   - Temporary signals deleted from `referee_signals`

4. **Archival**:
   - `signal_history` records include delivery timestamp
   - Records permanent for historical analysis and replay
   - No data loss if system crashes mid-animation

### 3. Connection Status Display

**Visual Indicators:**

- **Waiting** (Gray circle): No device connected
- **Connected** (Green pulsing dot): Active presence tracked
- **Signal Received** (Blue checkmark): Signal submitted and confirmed

**Real-time Updates:**
- Referee device sends heartbeat every 3 seconds
- Connection status updates immediately on RefereePage
- Display screen shows connection status for each position

### 4. State Machine

Each referee signal goes through a clear state progression:

```
IDLE → CONNECTED → SUBMITTED → DELIVERED → ARCHIVED
 ↓        ↓           ↓           ↓          ↓
None   Online      Signal      Confirmed   History
              Received        Animation  Record
                             Completed   Kept
```

**State Transitions:**
- **IDLE → CONNECTED**: Device heartbeat received
- **CONNECTED → SUBMITTED**: Referee holds button and confirms
- **SUBMITTED → DELIVERED**: Display screen receives signal
- **DELIVERED → ARCHIVED**: Animation completes, signal archival initiated

### 5. Error Recovery

**Scenario: Connection Lost During Animation**

Old System: Signals deleted → data lost
New System:
- Temporary signals deleted from `referee_signals`
- Permanent record in `signal_history` with submission + delivery times
- Display screen can reconstruct state if needed
- Manual review possible via signal history

**Scenario: Session Expires During Competition**

Old System: Silent failure
New System:
- Referee sees clear error message: "Session expired or invalid"
- Suggestions provided: "Request a new link from the referee coordinator"
- Coordinator clicks "Create New Session" to generate new token
- Referee uses new link to continue

## Database Schema

### referee_sessions

```sql
CREATE TABLE referee_sessions (
  id uuid PRIMARY KEY,
  competition_id text NOT NULL,
  created_at timestamptz,
  expires_at timestamptz (24 hours from creation),
  is_active boolean (default: true),
  created_by text
);
```

**Use:** Track active sessions, allow invalidation of old sessions

### signal_history

```sql
CREATE TABLE signal_history (
  id uuid PRIMARY KEY,
  session_id uuid REFERENCES referee_sessions,
  competition_id text NOT NULL,
  position smallint (0=left, 1=center, 2=right),
  signal text ('GOOD' or 'NO'),
  device_id text,
  submitted_at timestamptz,
  delivered_at timestamptz (null until display confirms),
  created_at timestamptz
);
```

**Use:** Permanent audit trail of all signals, historical analysis, replay

### referee_signals (unchanged)

```sql
CREATE TABLE referee_signals (
  id text PRIMARY KEY,
  competition_id text NOT NULL,
  position smallint,
  signal text,
  device_id text,
  updated_at timestamptz
);
```

**Use:** Real-time signal state for display screen, deleted after animation

## Component Architecture

### New Files Created

**Backend/Logic:**
- `/src/lib/RefereSignalManager.tsx` - Context provider for signal state management
- `/src/lib/db.ts` - Enhanced with session and history functions
- `/src/hooks/useRefereSessionValidation.ts` - Session validation logic
- `/src/hooks/useRefereSessionValidation.ts` - Session token extraction and validation

**UI Components:**
- `/src/components/RefereSlotCard.tsx` - Individual referee position display
- `/src/components/RefereConnectionStatus.tsx` - Connection status indicator
- `/src/components/SessionManager.tsx` - Session CRUD UI
- `/src/components/InvalidSessionError.tsx` - Error display for expired/invalid sessions

### Modified Files

**App.tsx:**
- Added session management buttons to RefereePage
- Integrated session validation into RefereeStationPage
- Enhanced DisplayFullPage animation cleanup

**useSupabaseSync.ts:**
- No changes needed - already supports dual-table operations
- Signal deletion already implemented correctly
- Presence tracking system already adequate

## User Workflows

### For Referee Coordinator

1. **Start Competition:**
   - Navigate to "Referee Signals" section
   - Click "Create New Session" button
   - Link automatically copied to clipboard
   - Share link with referees (QR code modal provides options)

2. **During Competition:**
   - Monitor "Referees Connected: X / 3" badge
   - Watch signal cards for GOOD/NO decisions
   - Observe result animation on display screen

3. **Between Lifts:**
   - Signals auto-clear after animation
   - System ready for next lift

4. **Reset Signals:**
   - Click "Reset All Signals" to manually clear
   - Click "Refresh Session" to invalidate old links
   - Create new session for next competition

### For Referee (Phone/Tablet)

1. **Connect to Session:**
   - Scan QR code from coordinator's screen
   - Or open shared link directly
   - System validates session automatically
   - See "Connected" status if valid

2. **Make Decision:**
   - Two large buttons: "GOOD LIFT" and "NO LIFT"
   - Hold button for 1 second to confirm (haptic feedback)
   - See confirmation when decision submitted
   - View current signal on screen

3. **Session Expires:**
   - See error: "Session expired or invalid"
   - Request new link from coordinator
   - Open new link and continue

### For Result Screen Display

1. **Wait for Signals:**
   - Three gray circles at top (one per referee)
   - Counter showing "Waiting for: 2 more signals"
   - Position names and indicators below

2. **Signals Arrive:**
   - Circles change: Green (GOOD) or Red (NO)
   - Animation plays based on decision
   - Circles remain visible during animation

3. **After Animation:**
   - Signals fade out automatically
   - System ready for next lift
   - Record saved permanently in database

## API Functions

### Session Management (`dbRefereeSessions`)

```typescript
// Create new session for competition
await dbRefereeSessions.create(competitionId: string): DbRefereeSession

// Validate session token
await dbRefereeSessions.validate(sessionId: string): DbRefereeSession | null

// Get all active sessions for competition
await dbRefereeSessions.getActiveForCompetition(competitionId: string): DbRefereeSession[]

// Invalidate all sessions for competition
await dbRefereeSessions.invalidateAll(competitionId: string): void

// Invalidate single session
await dbRefereeSessions.invalidateSession(sessionId: string): void
```

### Signal History (`dbSignalHistory`)

```typescript
// Record signal submission
await dbSignalHistory.create(
  sessionId: string,
  competitionId: string,
  position: number,
  signal: "GOOD" | "NO",
  deviceId: string
): DbSignalHistory

// Mark signal as delivered
await dbSignalHistory.markDelivered(historyId: string): void

// Get all signals for competition
await dbSignalHistory.listForCompetition(competitionId: string): DbSignalHistory[]

// Get recently delivered signals
await dbSignalHistory.listRecentDeliveries(competitionId: string, limit?: number): DbSignalHistory[]
```

## Testing Scenarios

### Test 1: Complete Successful Flow
1. Create new session → Session created and link copied
2. Open referee link on 3 devices → All show "Connected"
3. Each referee holds GOOD button → Signals appear on display
4. All 3 signals received → Animation plays
5. After animation → Signals cleared, ready for next lift
6. Verify `signal_history` contains all 3 records with delivered_at timestamps

### Test 2: Session Expiration
1. Create session → Link works
2. Wait 24 hours (or manually set expiration)
3. Try to open link → See "Session expired" error
4. Try "Try Again" → Still shows error
5. Create new session → New link works
6. Old session no longer appears in active sessions list

### Test 3: Signal Recovery
1. Start decision flow → All 3 signals submitted
2. Animation starts → Force page reload/close
3. Check `signal_history` → All 3 records exist with submitted_at
4. Some may have delivered_at, some may be null
5. Manually verify data consistency with original decision

### Test 4: Referee Disconnect
1. All 3 referees connected → 3 green dots
2. One referee closes browser → 2 green dots, 1 gray
3. After 7 seconds → Device removed from presence
4. Offline device rejoins → Green dot returns
5. Can still submit signals and complete decision

## Performance Considerations

**Real-time Sync:**
- Supabase presence for device connections (efficient)
- PostgreSQL change events for signal updates (optimized with filters)
- Separate channels for signals and presence (no coupling)

**Database Queries:**
- Indexed on (competition_id, submitted_at) for signal_history
- Indexed on (competition_id, is_active) for active sessions
- Automatic cleanup: old sessions can be archived via migration

**Network:**
- Session validation: 1 query per page load
- Signal submission: 1 insert (referee_signals) + 1 insert (signal_history)
- Signal delivery: 1 update (mark delivered)
- Total: 3-4 queries per decision cycle

## Future Enhancements

1. **Multi-round Support:** Track signals by lift/round number
2. **Signal Appeals:** Allow coordinator to request re-decision within X seconds
3. **Historical Reports:** Generate reports of signal patterns by referee
4. **Blind Testing:** Option to hide signal counts from display until all submitted
5. **Mobile App:** Native app for better reliability on poor networks
6. **Offline Mode:** Buffer signals locally, sync when connection restored

## Migration Path

If upgrading from old system:

1. Create new tables (`referee_sessions`, `signal_history`)
2. Import old signal records into `signal_history` for historical tracking
3. Keep `referee_signals` table for new decisions
4. Old referee links will continue to fail (graceful degradation)
5. Users directed to use new session-based links
6. After 24 hours: old sessions automatically expire

## Troubleshooting

**"Invalid or expired session" error:**
- Request new link from coordinator
- Check browser's localStorage for stale data (clear if needed)
- Verify clock sync on device

**Signals not appearing on display:**
- Verify all 3 referees shown as "Connected"
- Check network: all devices on same network
- Try "Reset All Signals" on RefereePage
- Reload display screen page

**"Failed to clear signals" error:**
- Usually temporary network issue
- Automatic retry triggered
- Manual override: close and reopen app
- Check Supabase status dashboard

**Session tokens look wrong:**
- Tokens are UUIDs (36 characters with hyphens)
- Each session creates new UUID
- Copy link from session management UI, don't type manually
