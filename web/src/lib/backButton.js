/**
 * Android hardware/gesture back button.
 *
 * In a Capacitor WebView, back exits the APP by default. That is wrong the
 * moment anything is open on top of the map: a phone user pressing back to
 * close the code viewer would instead be thrown out of Grapheon. Android users
 * treat back as "dismiss the top thing", and an app that ignores that feels
 * broken in a way no amount of on-screen close buttons fixes.
 *
 * Registers a stack of dismissers; the most recently pushed one that reports
 * it handled the press wins. Nothing happens on the web, where there is no
 * such event and the browser's own back is the router's business.
 *
 * @param {() => boolean} handler  return true if it consumed the press
 * @returns {() => void} unsubscribe
 */
const stack = [];
let wired = false;
let removeListener = null;

async function wire() {
  if (wired) return;
  wired = true;
  try {
    // Dynamic import: @capacitor/app is only meaningful inside the native
    // shell, and on the web this resolves to a no-op rather than a hard
    // dependency at module load.
    const { App } = await import('@capacitor/app');
    const sub = await App.addListener('backButton', ({ canGoBack }) => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]()) return; // consumed by the topmost dismisser
      }
      // Nothing open: fall back to normal navigation, then to exiting.
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
    removeListener = () => sub.remove();
  } catch {
    // Not running under Capacitor — no back button to listen for.
  }
}

export function onBackButton(handler) {
  stack.push(handler);
  wire();
  return () => {
    const i = stack.indexOf(handler);
    if (i !== -1) stack.splice(i, 1);
    if (!stack.length && removeListener) {
      removeListener();
      removeListener = null;
      wired = false;
    }
  };
}
