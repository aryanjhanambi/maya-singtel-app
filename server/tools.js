/**
 * The function tools Maya can call. Every one is executed by this app: the
 * browser tools through Playwright, the others by the run controller. There
 * is deliberately no tool that types text, reads field contents, or runs
 * script in the page.
 */

export const TOOL = {
  OBSERVE: 'browser_observe',
  NAVIGATE: 'browser_navigate',
  CLICK: 'browser_click',
  SCROLL: 'browser_scroll',
  SWITCH_TAB: 'browser_switch_tab',
  LOGIN: 'request_customer_login',
  SUBMIT: 'request_redemption_submission',
  REPORT: 'report_redemption_result',
};

export const BROWSER_TOOLS = new Set([TOOL.OBSERVE, TOOL.NAVIGATE, TOOL.CLICK, TOOL.SCROLL, TOOL.SWITCH_TAB]);

export const RESULT_OUTCOMES = ['confirmed', 'rejected', 'not_confirmed'];

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});

const text = (description) => ({ type: 'string', description });

export const toolDefinitions = [
  fn(
    TOOL.OBSERVE,
    'Read the page in the active browser tab: its address, title, open tabs, visible text, and a list of interactive elements with references. Field contents are never included. References are valid only until the next action.',
    {},
  ),
  fn(TOOL.NAVIGATE, 'Open an HTTPS address on an allowed website in the active tab.', {
    url: text('The complete https:// address to open.'),
  }),
  fn(TOOL.CLICK, 'Click one element from the latest browser_observe result.', {
    ref: text('The element reference from the latest observation, such as s3e12.'),
  }),
  fn(TOOL.SCROLL, 'Scroll the active tab by one screen.', {
    direction: { type: 'string', enum: ['up', 'down'], description: 'Which way to scroll.' },
  }),
  fn(TOOL.SWITCH_TAB, 'Make another open tab the active tab.', {
    tab_id: text('The tab_id from the latest observation.'),
  }),
  fn(
    TOOL.LOGIN,
    'Ask the customer to take control of the browser and sign in themselves, for example when CAST shows its sign-in page. You are paused while they do it and you are not shown what they type. The result only says that control has come back.',
    { reason: text('One short sentence telling the customer what to do, such as signing in to CAST.') },
  ),
  fn(
    TOOL.SUBMIT,
    'Ask the application to enter the customer’s redemption code and select the submit button once. Call this only when the signed-in, empty AI Pass code form on CAST is showing, right after observing it. The application asks the customer to authorize it. You never receive the code.',
    {
      code_field_ref: text('Reference of the empty redemption code field, from the latest observation.'),
      submit_button_ref: text('Reference of the button that submits the code, from the latest observation.'),
      account_context: text('The signed-in account shown on the page, such as a masked mobile number or a name. Empty string if none is shown.'),
      page_summary: text('One sentence on what this page offers and any terms it shows.'),
      payment_requested: { type: 'boolean', description: 'True if the page asks for payment details or shows a charge.' },
    },
  ),
  fn(
    TOOL.REPORT,
    'Report what the CAST page shows after the application submitted the code. Observe the page first and use its exact text. Never report confirmed unless the page itself shows that the redemption succeeded. The application captures the page as evidence.',
    {
      outcome: {
        type: 'string',
        enum: RESULT_OUTCOMES,
        description:
          'confirmed: the page shows the redemption succeeded. rejected: the page shows the code was refused. not_confirmed: neither is clearly shown.',
      },
      page_message: text('The exact confirmation or error text displayed by CAST.'),
      confirmation_reference: text('A reference or order number only if the page actually displays one. Otherwise an empty string.'),
    },
  ),
];
