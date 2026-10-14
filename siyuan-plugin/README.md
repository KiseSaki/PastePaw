# PastePaw WebDAV Sync

Manually synchronize PastePaw notes with a selected SiYuan document through your own WebDAV. Import-only remains the default; optional bidirectional mode sends changes from bound note regions back to PastePaw. Windows and Android with SiYuan 3.8.6 or later are the target environments. Real devices, SiYuan's installed Lute conversion and server compatibility require installation testing.

See [the Chinese guide](README.zh-CN.md) for installation, encrypted credential storage, import rules and limitations.

Upgrade all computers to PastePaw 1.6.0 and this plugin to 0.3.0 before enabling writes. Notes migrate to format 3, which older clients reject. Bidirectional mode requires WebDAV write permissions and uses the same lease, strong ETags and conditional updates as PastePaw. Three-way comparison merges independent fields and non-overlapping content, while overlapping edits and delete/edit conflicts retain both versions for review. Conflict decisions persist across offline retries. This is manual synchronization rather than real-time collaborative editing.

Only bound note superblocks are returned. Ordinary content can be explicitly created as a new note; deleting or detaching a SiYuan region does not delete the cloud note. Unsupported blocks remain in SiYuan and that note is skipped. Images and files require separate paragraphs, are hashed and limited to 20 MiB each, and count toward the shared cloud budget (500 MiB by default).

Device credentials use PBKDF2-SHA256 and AES-256-GCM; the unlock password is not persisted. Document baselines in `data/storage/petal/pastepaw-webdav-sync/sync-<documentId>.json` contain note content and asset paths, but no connection credentials. Wait for SiYuan workspace synchronization before syncing the same document from another device; simultaneous offline imports may create duplicates. Both versions can be compared and resolved in the plugin panel or the PastePaw note window.

HTTP and HTTPS endpoints are supported. HTTP sends WebDAV credentials and note contents in plaintext; HTTPS requires a valid certificate. Local credential files remain encrypted with either protocol. Unlock passwords require at least 6 characters. Existing vaults still use their original password; configure and save the credentials again to change it.

Build from the PastePaw repository root with `pnpm build:siyuan`; run `pnpm test:siyuan` for the import and encryption tests. This is a local installation package, not a marketplace publication.
