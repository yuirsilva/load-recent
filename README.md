# Instagram Oldest First

A Chrome extension with only a small progress chip. It loads Instagram's existing Relay connection directly, then asks Instagram's own React grid to display its native post records from oldest to newest. It does not recreate the profile grid or post UI.

It deliberately does not simulate scrolling, clone posts, or replace React-owned markup. Instagram's normal forward pagination query fills the live Relay store, then the extension sorts that connection's edge records by `taken_at`. Native post tiles, hover overlays, menus, and click handlers remain Instagram's.

## Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Reload Instagram once so the early page hook is active.
5. Open a profile's **Posts** tab and press **Alt+Shift+O**.

The page does not scroll. A visible status chip reports progress while the extension executes Instagram's own profile-post Relay query page by page. When the connection is complete, the extension sorts its native edges oldest-first. Press **Alt+Shift+O** again while loading to stop, or after loading to restore the original connection.

Completed profiles are cached in the browser. On later visits, if the profile's post count and currently visible post IDs still match, the saved native Relay records are restored immediately. A changed count or a newly visible post invalidates the cache and triggers a fresh load.

Chrome lets you change the shortcut at `chrome://extensions/shortcuts` if it conflicts with another extension.

## Practical limits

- Instagram still has to deliver every page from newest toward oldest, so large profiles take time and may hit Instagram's own throttling. The extension will not show a misleading partial result.
- The final order uses each native Relay record's `taken_at` timestamp, so pinned posts are placed by their actual post date.
- Posts removed, withheld, age-gated, or unavailable to the signed-in account cannot be loaded.
