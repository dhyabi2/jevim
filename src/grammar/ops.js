// What each verb actually does to an element. Kept tiny and side-effect-only: the runner
// decides what to act on, these decide how.

export function createOps(win) {
  const doc = win.document;

  return {
    goto(el) {
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return 'clicked';
    },

    yank(el) {
      const text = el.getAttribute('href') || el.value || el.textContent || '';
      const trimmed = text.trim();
      if (win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(trimmed);
      return trimmed;
    },

    change(el) {
      if (typeof el.focus === 'function') el.focus();
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      return 'cleared';
    },

    dismiss(el) {
      el.style.display = 'none';
      el.setAttribute('data-jevim-dismissed', '1');
      return 'hidden';
    },

    select(el) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = win.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return 'selected';
    },
  };
}
