// Static 2026 entry list, values from OpenF1's drivers rows for session 11361 (2026 Italian GP). Replaced by the OpenF1 drivers fetch in #39.
//
// Owner decision (round 4 on PR #31): the entry list is hardcoded for now,
// not fetched. HLD §7: "Drivers are events. ... The fold carries them; a
// swap arrives as a new row; Driver stays a field inside RaceState, not a
// table." — so emitting these as `drivers` events (rest-lane.ts, on session
// selection) through the normal path is consistent with that fact, even
// though the source is this static list rather than a live fetch.
export const ENTRY_LIST_2026 = [
  { driver_number: 1,  full_name: "Lando NORRIS",       name_acronym: "NOR", team_name: "McLaren",         team_colour: "F47600" },
  { driver_number: 3,  full_name: "Max VERSTAPPEN",     name_acronym: "VER", team_name: "Red Bull Racing", team_colour: "4781D7" },
  { driver_number: 5,  full_name: "Gabriel BORTOLETO",  name_acronym: "BOR", team_name: "Audi",            team_colour: "F50537" },
  { driver_number: 10, full_name: "Pierre GASLY",       name_acronym: "GAS", team_name: "Alpine",          team_colour: "00A1E8" },
  { driver_number: 11, full_name: "Sergio PEREZ",       name_acronym: "PER", team_name: "Cadillac",        team_colour: "909090" },
  { driver_number: 12, full_name: "Kimi ANTONELLI",     name_acronym: "ANT", team_name: "Mercedes",        team_colour: "00D7B6" },
  { driver_number: 14, full_name: "Fernando ALONSO",    name_acronym: "ALO", team_name: "Aston Martin",    team_colour: "229971" },
  { driver_number: 16, full_name: "Charles LECLERC",    name_acronym: "LEC", team_name: "Ferrari",         team_colour: "ED1131" },
  { driver_number: 18, full_name: "Lance STROLL",       name_acronym: "STR", team_name: "Aston Martin",    team_colour: "229971" },
  { driver_number: 22, full_name: "Yuki TSUNODA",       name_acronym: "TSU", team_name: "Racing Bulls",    team_colour: "6C98FF" },
  { driver_number: 23, full_name: "Alexander ALBON",    name_acronym: "ALB", team_name: "Williams",        team_colour: "1868DB" },
  { driver_number: 27, full_name: "Nico HULKENBERG",    name_acronym: "HUL", team_name: "Audi",            team_colour: "F50537" },
  { driver_number: 30, full_name: "Liam LAWSON",        name_acronym: "LAW", team_name: "Red Bull Racing", team_colour: "4781D7" },
  { driver_number: 31, full_name: "Esteban OCON",       name_acronym: "OCO", team_name: "Haas F1 Team",    team_colour: "9C9FA2" },
  { driver_number: 41, full_name: "Arvid LINDBLAD",     name_acronym: "LIN", team_name: "Racing Bulls",    team_colour: "6C98FF" },
  { driver_number: 43, full_name: "Franco COLAPINTO",   name_acronym: "COL", team_name: "Alpine",          team_colour: "00A1E8" },
  { driver_number: 44, full_name: "Lewis HAMILTON",     name_acronym: "HAM", team_name: "Ferrari",         team_colour: "ED1131" },
  { driver_number: 55, full_name: "Carlos SAINZ",       name_acronym: "SAI", team_name: "Williams",        team_colour: "1868DB" },
  { driver_number: 63, full_name: "George RUSSELL",     name_acronym: "RUS", team_name: "Mercedes",        team_colour: "00D7B6" },
  { driver_number: 77, full_name: "Valtteri BOTTAS",    name_acronym: "BOT", team_name: "Cadillac",        team_colour: "909090" },
  { driver_number: 81, full_name: "Oscar PIASTRI",      name_acronym: "PIA", team_name: "McLaren",         team_colour: "F47600" },
  { driver_number: 87, full_name: "Oliver BEARMAN",     name_acronym: "BEA", team_name: "Haas F1 Team",    team_colour: "9C9FA2" },
] as const;
