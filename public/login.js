const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const submit = document.querySelector('#submit');
const error = document.querySelector('#error');
const toggle = document.querySelector('#toggle-password');
const turnstileContainer = document.querySelector('#turnstile');
let turnstileToken = null;
let turnstileWidget = null;
let turnstileRequired = false;

function loadTurnstile() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Verification could not be loaded. Please refresh and try again.'));
    document.head.append(script);
  });
}

async function initializeVerification() {
  try {
    const response = await fetch('/api/auth/status');
    const status = await response.json();
    turnstileRequired = Boolean(status.turnstileSiteKey);
    if (!turnstileRequired) {
      submit.disabled = false;
      return;
    }
    turnstileContainer.hidden = false;
    await loadTurnstile();
    turnstileWidget = window.turnstile.render(turnstileContainer, {
      sitekey: status.turnstileSiteKey,
      action: 'maya-login',
      theme: 'light',
      size: 'flexible',
      callback(token) {
        turnstileToken = token;
        submit.disabled = false;
      },
      'expired-callback'() {
        turnstileToken = null;
        submit.disabled = true;
      },
      'error-callback'() {
        turnstileToken = null;
        submit.disabled = true;
      },
    });
  } catch (failure) {
    error.textContent = failure.message ?? 'Verification could not be loaded. Please refresh and try again.';
    error.hidden = false;
    submit.disabled = true;
  }
}

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
  if (turnstileRequired && !turnstileToken) {
    error.textContent = 'Please complete the verification first.';
    error.hidden = false;
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Maya-Request': '1' },
      body: JSON.stringify({ password: password.value, turnstileToken }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? 'Sign-in failed.');
    window.location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    password.select();
  } finally {
    if (turnstileRequired && turnstileWidget !== null) {
      window.turnstile.reset(turnstileWidget);
      turnstileToken = null;
    }
    submit.disabled = turnstileRequired;
    submit.textContent = 'Continue';
  }
});

initializeVerification();
