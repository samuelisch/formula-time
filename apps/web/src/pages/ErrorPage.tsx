// The router's errorElement (owner report: an unmatched path, e.g.
// /races/11353 on a deploy where only the chooser has merged, rendered
// React Router's default unstyled "Unexpected Application Error!" page).
// Mounted on the root layout route in app/router.tsx, so it renders in
// place of Shell -- no live store, no nav -- hence the shell palette
// variables (index.css) rather than any Shell-dependent styling.
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
