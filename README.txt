Kick Following: Chatters or Viewers (Sidebar Native Edition)

INSTALL (Chrome, Edge, Brave, Opera)
1. Open chrome://extensions and turn on Developer mode (top right).
2. Click "Load unpacked" and select this project directory.
3. Open or refresh kick.com while logged in.
4. The enhanced Following section seamlessly renders directly inside Kick's left sidebar as the primary Following list.

KEY FEATURES
- Show Deleted Chat Messages: Keep deleted and banned messages visible in chat with clear visual indicators ([DELETED] red badge, strikethrough text, red left border, and subtle red tint). Never miss what was deleted or who was banned!
- Sidebar Integration: Appears directly in Kick's left sidebar, perfectly matching Kick's native typography, dark palette, badges, and layout.
- Native List Replacement: Non-destructively replaces/suppresses Kick's basic Following section so there are no duplicate lists.
- Full Streamer Visibility: Displays both LIVE streamers and OFFLINE streamers with Kick's authentic offline icon.
- Show More / Show Less: Initially shows 5 channels (customizable), with a clean "Show More (N)" button that expands to display all followed channels.
- Inline Mode Switcher: 1-click toggle in the section header to instantly switch between:
  * 💬 Active Chatters (Range based on Pusher WebSocket + Kick API)
  * 👁️ Viewers (Kick's official live viewer count)
- Collapsed Sidebar Support: Automatically adapts when the Kick sidebar is collapsed into icon-only mode (~60px), displaying centered avatars with live badges and rich tooltips.
- Rich Hover Tooltips: Hovering any live streamer reveals live viewers, active chatters in the window, API counts, and stream title.

HOW DELETED & MODERATED CHAT MESSAGES WORK
- Real-time DOM Preservation: A MutationObserver watches #chatroom-messages for removals. When a message is removed by a moderator or bot (or user timeout/ban), it is immediately preserved in its exact position.
- Advanced Moderation Parsing: Listens to Pusher moderation events (App\Events\UserBannedEvent, ChatUserBannedEvent, UserTimedOutEvent, ChatUserTimedOutEvent, MessageDeletedEvent).
- Timeout vs Ban Distinction:
  * 🟡 TIMEOUT: Displays an amber/gold badge with exact duration and moderator info (e.g., [TIMEOUT 5m • by modName] or [TIMEOUT 1w • by streamer]), along with an amber left border and strikethrough.
  * 🔴 PERMANENT BAN: Displays a bold crimson badge (e.g., [BANNED (PERMA) • by modName]), along with a red left border and strikethrough.
  * 🔴 SINGLE MESSAGE DELETED: Displays a red [DELETED] badge when a message was specifically deleted without a user ban.
- Duration Calculation: Automatically calculates friendly durations from expiration timestamps or seconds (e.g., 5m, 10m, 30m, 1h, 24h, 1w).
- Moderator Attribution: Displays the moderator or broadcaster who issued the timeout or ban right inside the badge and hover tooltip.
- Smart Prune Detection: Natural FIFO scroll pruning from the top of the chat buffer (scrolling past 100+ messages) is distinguished from moderation deletions to avoid memory leaks.
- Toggle in Settings: Can be enabled or disabled at any time from the extension popup.

HOW THE CHATTER RANGE WORKS
- Low end: Count of unique users who sent a chat message inside your chat window (default 5 min), tracked via Pusher WebSocket.
- High end: Kick's active chatters API, polled every 30 sec for each live channel.
- Safe resource management: Only live channels connect to Pusher WebSocket and poll active chatters. Offline channels consume zero socket connections.
- Smart fallbacks: The low end never exceeds the high end, and the high end never exceeds the total live viewer count. Known bots are automatically ignored.

SETTINGS POPUP
Click the extension toolbar icon in your browser to configure:
- Default display mode (Chatters range vs Viewers count)
- Initial visible channels before "Show More"
- Chat activity window (1–30 min)
- Refresh interval (15–120 sec)
- Kick active chatters API ceiling toggle
- Bot filtering and custom bot usernames list

DATA SOURCES
- GET /api/v2/channels/followed                  Followed channels (live + offline)
- GET /api/v2/channels/{slug}                    Channel and chatroom IDs (for live streams)
- GET /api/v2/channels/{id}/messages             Recent chat history to seed chat window
- GET /api/v1/channels/{id}/chat/active-chatters Kick active chatters count
- wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679 Real-time chat events
