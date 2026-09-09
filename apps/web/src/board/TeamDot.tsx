// The small coloured dot before a team name -- shared by DriverRow (the
// timing table) and DriverPanel, so both places stay one component.
import { text } from "../lib/format.ts";
import styles from "./TeamDot.module.css";

export interface TeamDotProps {
  teamColour: string | null;
}

export function TeamDot({ teamColour }: TeamDotProps) {
  return <span className={styles.teamDot} style={{ background: `#${text(teamColour, "888")}` }} aria-hidden="true" />;
}
