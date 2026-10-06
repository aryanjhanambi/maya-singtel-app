const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const submit = document.querySelector('#submit');
const error = document.querySelector('#error');
const toggle = document.querySelector('#toggle-password');

toggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  toggle.textContent = visible ? 'Show' : 'Hide';
  toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  password.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Maya-Request': '1' },
      body: JSON.stringify({ password: password.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? 'Sign-in failed.');
    window.location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    password.select();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Continue';
  }
});
