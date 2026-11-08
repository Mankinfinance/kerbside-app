// Runtime configuration, read once from environment variables.
// Secrets (Square token, session secret) only ever come from the environment, never from code or the client.

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

const gateway = (env.GATEWAY || 'fake').toLowerCase();
if (!['fake', 'square'].includes(gateway)) throw new Error('GATEWAY must be "fake" or "square"');

const squareEnv = (env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
if (!['sandbox', 'production'].includes(squareEnv)) throw new Error('SQUARE_ENVIRONMENT must be "sandbox" or "production"');

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  dbPath: env.DB_PATH || 'data/kerbside.db',
  gateway,
  // Cookies are marked Secure unless explicitly running locally over http.
  secureCookies: env.INSECURE_COOKIES !== '1',
  sessionHours: Number(env.SESSION_HOURS || 12),
  // How long a held order waits for "Leaving now" before it is released to the kitchen anyway.
  holdMaxMinutes: Number(env.HOLD_MAX_MINUTES || 60),
  pointsPerDollar: Number(env.POINTS_PER_DOLLAR || 5),
  square: gateway === 'square'
    ? {
        environment: squareEnv,
        baseUrl: squareEnv === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com',
        webSdkUrl: squareEnv === 'production' ? 'https://web.squarecdn.com/v1/square.js' : 'https://sandbox.web.squarecdn.com/v1/square.js',
        accessToken: required('SQUARE_ACCESS_TOKEN'),
        applicationId: required('SQUARE_APPLICATION_ID'),
        version: env.SQUARE_VERSION || '2025-01-23',
      }
    : null,
};
