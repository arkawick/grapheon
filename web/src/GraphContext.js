import { createContext, useContext } from 'react';

/**
 * Everything the pages share: the loaded corpus, the live renderer, and the
 * selection. Lives in a context rather than props because the Atlas canvas is
 * mounted ABOVE the router (so navigating never tears down the WebGL context),
 * which means pages cannot receive it by prop drilling from a common parent.
 */
export const GraphContext = createContext(null);

export function useGraph() {
  const ctx = useContext(GraphContext);
  if (!ctx) throw new Error('useGraph must be used inside <GraphContext.Provider>');
  return ctx;
}
