import { createBrowserRouter } from "react-router";

import { BoardPage } from "../pages/BoardPage.tsx";
import { ErrorPage } from "../pages/ErrorPage.tsx";
import { PollsPage } from "../pages/PollsPage.tsx";
import { RacesPage } from "../pages/RacesPage.tsx";
import { ReplayPage } from "../pages/ReplayPage.tsx";
import { Shell } from "./Shell.tsx";

// `/` is the chooser (RacesPage), `/live` the live board, `/races/:session_key`
// the replay, `/polls` unchanged (owner ruling on issue #57). `errorElement`
// on the root layout route replaces React Router's default unstyled error
// page (owner report: an unmatched path rendered "Unexpected Application
// Error!") -- it renders in place of Shell, so it never depends on the live
// store or nav.
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <RacesPage /> },
      { path: "live", element: <BoardPage /> },
      { path: "races/:session_key", element: <ReplayPage /> },
      { path: "polls", element: <PollsPage /> },
    ],
  },
]);
