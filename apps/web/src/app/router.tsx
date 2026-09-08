import { createBrowserRouter } from "react-router";

import { BoardPage } from "../pages/BoardPage.tsx";
import { PollsPage } from "../pages/PollsPage.tsx";
import { Shell } from "./Shell.tsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <BoardPage /> },
      { path: "polls", element: <PollsPage /> },
    ],
  },
]);
