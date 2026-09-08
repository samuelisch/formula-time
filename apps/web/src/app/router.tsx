import { createBrowserRouter } from "react-router";

import { BoardPage } from "../pages/BoardPage.tsx";
import { PollsPage } from "../pages/PollsPage.tsx";
import { RacesPage } from "../pages/RacesPage.tsx";
import { ReplayPage } from "../pages/ReplayPage.tsx";
import { Shell } from "./Shell.tsx";

// `/` is the chooser (RacesPage), `/live` the live board, `/races/:session_key`
// the replay, `/polls` unchanged (owner ruling on issue #57).
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <RacesPage /> },
      { path: "live", element: <BoardPage /> },
      { path: "races/:session_key", element: <ReplayPage /> },
      { path: "polls", element: <PollsPage /> },
    ],
  },
]);
