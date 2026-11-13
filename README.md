# B4 AntiNuke

A starter Discord.js antinuke monitor. It watches channel/role deletions, bans, kicks, and bot additions, checks audit logs, sends alerts, and times out an untrusted executor after repeated suspicious actions.

## Setup
1. Create a Discord application and bot in the Developer Portal.
2. Enable **Server Members Intent**. Invite it with View Audit Log, Moderate Members, View Channels, and Send Messages permissions. Keep its role below the server owner and above roles it must moderate.
3. Copy `.env.example` to `.env` and fill in the values.
4. Run `npm install` then `npm start`.

Deploy on Railway with start command `npm start`. Add the environment variables in Railway instead of uploading `.env`.

## Important
- This is a starter implementation, not a guarantee against every raid or exploit. Test in a private server first.
- Discord audit-log events can arrive late; a bot cannot undo all damage after the fact.
- Keep the bot token secret and never commit it.
- `/deletechannels` is available to members with the Discord **Administrator** permission. The bot also needs **Manage Channels**. The command requires the exact confirmation phrase `DELETE CHANNELS` before deleting channels, and it excludes the configured log channel.
- Give the bot only the permissions it needs. The bot cannot protect against actions by the server owner.
