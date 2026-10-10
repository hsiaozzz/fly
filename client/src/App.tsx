import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import PlayGame from "./pages/PlayGame";
import { useAuth } from "./_core/hooks/useAuth";
import { useEffect } from "react";

function Router() {
  const { isAuthenticated, loading } = useAuth();
  useEffect(() => {
    if (loading || !isAuthenticated || window.location.pathname !== "/") return;
    try {
      const returnTo = sessionStorage.getItem("arcane.returnTo");
      sessionStorage.removeItem("arcane.returnTo");
      if (returnTo && /^\/play\/[a-f\d-]+(?:\?share=[\w-]+)?$/i.test(returnTo))
        window.location.replace(returnTo);
    } catch {
      /* Returning to the workspace is always a safe default. */
    }
  }, [loading, isAuthenticated]);
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path="/explore" component={Explore} />
      <Route path="/play/:publicationId">
        {params => <PlayGame publicationId={params.publicationId} />}
      </Route>
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
