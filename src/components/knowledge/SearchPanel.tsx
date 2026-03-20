import { memo, useCallback, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";

interface SearchPanelProps {
  baseId: string;
}

export const SearchPanel = memo(function SearchPanel({ baseId }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const { searchResults, searchQuery, isSearching, search } = useKnowledgeStore(
    useShallow((s) => ({
      searchResults: s.searchResults,
      searchQuery: s.searchQuery,
      isSearching: s.isSearching,
      search: s.search,
    })),
  );

  const handleSearch = useCallback(() => {
    if (!query.trim()) return;
    search(baseId, query.trim()).catch(console.error);
  }, [query, baseId, search]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter") handleSearch();
    },
    [handleSearch],
  );

  return (
    <div className="kb-search">
      <div className="kb-search__bar">
        <input
          className="kb-search__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search knowledge base…"
        />
        <button className="kb-search__btn" onClick={handleSearch} disabled={isSearching || !query.trim()}>
          {isSearching ? <Loader2 size={16} className="kb-status__spinner" /> : <Search size={16} />}
        </button>
      </div>

      {searchResults.length > 0 && (
        <div className="kb-search__results">
          {searchResults.map((r, i) => (
            <div key={`${r.documentId}-${i}`} className="kb-search__result">
              <div className="kb-search__result-header">
                <span className="kb-search__result-doc">{r.documentName}</span>
                <span className="kb-search__result-score">{(r.score * 100).toFixed(0)}%</span>
              </div>
              <div className="kb-search__result-text">
                {r.chunkText.length > 300 ? `${r.chunkText.slice(0, 300)}…` : r.chunkText}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isSearching && searchResults.length === 0 && searchQuery && (
        <div className="kb-empty">No results found</div>
      )}
    </div>
  );
});
