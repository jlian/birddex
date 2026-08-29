# Anonymous account merge

WingDex lets anonymous users save data before creating an account. A successful
credential ceremony must keep that data without making the user choose between
signup and login behavior.

## Behavior matrix

| Starting state | Credential result | WingDex behavior |
| --- | --- | --- |
| Anonymous | New social identity | Better Auth creates the registered target, then WingDex merges the anonymous source into it. |
| Anonymous | Existing social identity | Better Auth authenticates the existing target, then WingDex merges the anonymous source into it. |
| Anonymous | Existing passkey | Better Auth authenticates the existing target, then WingDex merges the anonymous source into it. |
| Anonymous | New passkey | The passkey ceremony promotes the same user, then the shared finalizer records a same-user promotion. |
| Sessionless | Any social or passkey flow | Ordinary Better Auth authentication with no merge source. Sessionless passkey signup creates user, passkey, and session transactionally. |
| Registered | Add or manage passkeys | Credential management stays on the current account, with no data merge. |

Social authentication always uses ordinary `signIn.social`. The account-access
UI does not probe ownership with `linkSocial`, parse ownership conflicts, or run
a second provider ceremony.

Social-provider linking for an already registered account is intentionally not
exposed. Registered users manage passkeys and profile settings without entering
the anonymous merge flow.

## Security and recovery

Before authentication, the server creates a five-minute merge intent from the
current anonymous session. The client receives only an opaque token. Source and
target user IDs are always derived by the server.

The five-minute window controls starting a credential ceremony. A matching
Better Auth callback may bind its target after that window, and an unbound intent
is retained for a bounded callback grace period. Starting another ceremony for
the same anonymous session supersedes the prior unbound intent.

The first authenticated target durably claims the intent. A retry cannot choose
another target. Better Auth automatic anonymous deletion stays disabled; WingDex
deletes a different anonymous source only in the successful D1 transfer batch.
Cancellation leaves the source unchanged. A failed transfer keeps the source,
target claim, and token so web or iOS can retry after a callback or relaunch.

## Data policy

The direct merge preserves outings, photos, every observation certainty state,
photo references, AI metadata, dex metadata, import identities, and daily usage.
Target profile, credentials, passkeys, sessions, and Apple revocation credentials
remain authoritative.

Only authoritative, field-identical observation lineage is deduplicated. A
matching non-empty eBird submission ID plus normalized species identifies a
candidate, but differing durable fields are preserved. Time, location, species,
and count alone are never a dedupe key.