// The router's errorElement -- catches an unmatched path (e.g. an
// unroutable /races/:session_key) that would otherwise render React
// Router's default unstyled error page. Mounted on the root layout route
// in app/router.tsx, so it renders in place of Shell -- no live store, no
// nav -- hence the shell palette variables (index.css) rather than any
// Shell-dependent styling.
import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import styles from "./ErrorPage.module.css";

function messageFor(error: unknown): string {
  if (isRouteErrorResponse(error)) return error.statusText || `Error ${error.status}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{notFound ? "Page not found" : "Something went wrong"}</h1>
      {!notFound && <p className={styles.message}>{messageFor(error)}</p>}
      <Link className={styles.link} to="/">
        Back to races
      </Link>
    </div>
  );
}
