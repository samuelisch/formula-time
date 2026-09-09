// The small coloured dot before a team name -- shared by DriverRow (the
// timing table) and DriverPanel (issue #90 review round 2: the issue's own
// quoted rule, "no copy-paste between files; if two places need it, it is
// one component or one hook").
import { text } from "../lib/format.ts";
import styles from "./TeamDot.module.css";

export interface TeamDotProps {
  teamColour: string | null;
}

export function TeamDot({ teamColour }: TeamDotProps) {
  return <span className={styles.teamDot} style={{ background: `#${text(teamColour, "888")}` }} aria-hidden="true" />;
}
