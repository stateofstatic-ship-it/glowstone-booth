const button = document.getElementById('unsubscribe-button');
const status = document.getElementById('status');
let current;
let activeRequest;
function readLink() {
  activeRequest?.abort();
  const parameters = new URLSearchParams(location.hash.slice(1));
  const api = parameters.get('api') || '';
  const token = parameters.get('u') || '';
  const valid = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(api) && /^[a-f0-9]{64}$/.test(token);
  current = { api, token, valid, completed: false };
  // The fragment is never sent in page requests, caches or referrers. Keep it only in memory.
  history.replaceState(null, '', location.pathname);
  button.disabled = !valid;
  button.textContent = 'Unsubscribe';
  status.textContent = valid ? 'Select Unsubscribe to stop future Glowstone marketing emails. No sign-in required.' : 'This link is unavailable. Reopen the full link in your email or reply to Glowstone for help.';
}
readLink();
window.addEventListener('hashchange', readLink);
document.getElementById('unsubscribe-form').addEventListener('submit', async event => {
  event.preventDefault();
  const link = current;
  if (!link.valid || link.completed || button.disabled) return;
  button.disabled = true;
  status.textContent = 'Saving your unsubscribe request…';
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(link.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'unsubscribe', u: link.token }), credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    if (!response.ok) throw new Error('request failed');
    const result = await response.json();
    if (result.ok !== true) throw new Error('unsubscribe was not saved');
    if (current !== link) return;
    link.completed = true;
    status.textContent = 'You are unsubscribed from Glowstone marketing emails. Your giveaway entry and any unexpired discount code remain valid.';
    button.textContent = 'Unsubscribed';
  } catch {
    if (current !== link) return;
    status.textContent = 'We could not confirm your unsubscribe request. Check your connection and retry, or reply to your Glowstone email for help.';
    button.disabled = false;
  } finally { clearTimeout(timeout); }
});
