const form = document.querySelector('#contact-form');

if (form) {
  const fieldset = form.querySelector('fieldset');
  const button = form.querySelector('button[type="submit"]');
  const status = document.querySelector('#contact-status');
  const endpoint = form.getAttribute('action') || '';
  const configured = /^https:\/\/formspree\.io\/f\/[a-zA-Z0-9]+$/.test(endpoint);
  const label = button.innerHTML;
  let submitting = false;

  fieldset.disabled = !configured;
  status.hidden = configured;

  form.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      event.target.setCustomValidity('');
    }
  });

  form.addEventListener('submit', (event) => {
    if (!configured || submitting) {
      event.preventDefault();
      return;
    }
    for (const name of ['name', 'email', 'message']) {
      const field = form.elements.namedItem(name);
      field.value = field.value.trim();
      field.setCustomValidity(field.value ? '' : 'この項目を入力してください。');
    }
    if (!form.reportValidity()) {
      event.preventDefault();
      return;
    }
    // Native POST preserves Formspree's verification and receipt flow.
    // Keep the fields enabled so the browser includes them in the request.
    submitting = true;
    button.disabled = true;
    button.textContent = '送信しています…';
  });

  window.addEventListener('pageshow', () => {
    submitting = false;
    button.disabled = false;
    button.innerHTML = label;
  });
}
