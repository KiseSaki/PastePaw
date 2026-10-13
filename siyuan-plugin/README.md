# PastePaw WebDAV Sync

Import all PastePaw notes from your own WebDAV into a selected SiYuan document. Windows and Android with SiYuan 3.8.6 or later are the target environments. Real device and server compatibility must be verified after installation.

See [the Chinese guide](README.zh-CN.md) for installation, encrypted credential storage, import rules and limitations.

The plugin reads `notes.json` and referenced note attachments. It never writes to WebDAV. Device-specific credentials are encrypted with PBKDF2-SHA256 and AES-256-GCM; the unlock password is not persisted. Manually edited blocks are preserved and reported as conflicts. Wait for SiYuan workspace synchronization before importing the same document from another device; simultaneous offline imports may create duplicates.

HTTP and HTTPS endpoints are supported. HTTP sends WebDAV credentials and note contents in plaintext; HTTPS requires a valid certificate. Local credential files remain encrypted with either protocol. Unlock passwords require at least 6 characters. Existing vaults still use their original password; configure and save the credentials again to change it.

Build from the PastePaw repository root with `pnpm build:siyuan`; run `pnpm test:siyuan` for the import and encryption tests. This is a local installation package, not a marketplace publication.
