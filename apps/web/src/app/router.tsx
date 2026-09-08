import { createBrowserRouter } from "react-router";

import { BoardPage } from "../pages/BoardPage.tsx";
import { PollsPage } from "../pages/PollsPage.tsx";
import { RacesPage } from "../pages/RacesPage.tsx";
import { Shell } from "./Shell.tsx";

// `/` is the chooser (RacesPage), `/live` the live board, `/polls` unchanged
// (owner ruling on issue #57). `/races/:session_key` (the replay) lands with
// the stacked PR 2.
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <RacesPage /> },
      { path: "live", element: <BoardPage /> },
      { path: "polls", element: <PollsPage /> },
    ],
  },
]);
