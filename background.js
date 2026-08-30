chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-oldest-first") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.instagram.com/")) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "instagram-oldest-first:toggle" });
  } catch {
    // Instagram may still be navigating; the next shortcut press can retry.
  }
});
