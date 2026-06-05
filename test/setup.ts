// Minimal env so config validation passes during tests. We intentionally DO NOT set
// Salesforce credentials here — tests assert the "not configured" behaviour.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/inkpath_test";
process.env.APP_BASE_URL ??= "http://localhost:3000";
