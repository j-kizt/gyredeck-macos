Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Removing Discord keeps multi-factor authentication — (v1.39.6)

### Fixes

- **Removing Discord no longer removes multi-factor authentication.** Removing the Discord bot
  also deleted the multi-factor authentication record, so the codes in your authenticator app
  stopped working and it had to be set up again from scratch, though nothing on the confirmation
  said so. Remove now leaves multi-factor authentication as it was. Its confirmation reads: "Remove
  Discord? The bot stops and its token is deleted. Posts already in Discord stay there.
  Multi-factor authentication is not changed."
- **Multi-factor authentication has its own Remove.** In Settings → Connection → Security, the
  Multi-factor authentication row now shows a Remove button beside Reset when it is set up. It is
  not offered while it is off, being set up, locked or unreadable. Remove asks first: "Remove
  multi-factor authentication? The codes in your authenticator app stop working, and approvals
  sent from outside this Mac are refused until you set it up again." Cancel changes nothing.
  Confirming deletes the record. If the removal does not finish, the row says so and
  multi-factor authentication stays on.
