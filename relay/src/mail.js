// The sign-in email and where its request came from, apart from accounts.js (which needs the
// Workers runtime) so they run under node --test (test/mail.test.mjs).
// The sign-in email: the code for the page that asked, then the link for any other device. The
// link's token rides in the fragment, which browsers never send to a server, so no request line,
// log or mail scanner's prefetch carries it (the page also takes a ?signin= link, for a wrapper
// that loses fragments). The code stays out of the subject, which lock screens show. It says
// where the request came from, so a request that wasn't the reader's stands out.
export function signinMail(origin, { token, code }, from, t = Date.now()) {
  const url = `${origin}/account#signin=${token}`;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const where = [from?.city, from?.country].filter(Boolean).join(', ');
  const when = new Date(t).toISOString().slice(11, 16);
  return {
    subject: 'Your dibs sign-in code',
    text: `Your dibs sign-in code:\n\n    ${spaced}\n\nType it on the page that asked. It works once, for 10 minutes.\n\n`
      + `On another device, open this link instead (it signs in there, once):\n${url}\n\n`
      + `Asked from ${from?.device || 'a browser'}${where ? ` near ${where}` : ''} at ${when} UTC.\n`
      + `If this wasn't you, ignore this email: nobody can sign in without the code or the link.\n`,
  };
}

// "Chrome on Mac", in the words the page uses for itself (web/transport.js deviceName), from the
// User-Agent: only a label for the email, never trusted for anything.
export function deviceOf(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}
// Where a request came from, as Cloudflare places it (request.cf), for the email.
export const fromOf = req => ({ device: deviceOf(req.headers.get('User-Agent') || ''), city: req.cf?.city || null, country: req.cf?.country || null });

