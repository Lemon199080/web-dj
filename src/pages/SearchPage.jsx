import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import DoujinCard from '../components/DoujinCard';
import Pagination from '../components/Pagination';
import { searchDoujins } from '../services/api';
import { Search, BookOpen, Filter, X } from 'lucide-react';

const getSlug = (link) => {
  if (!link) return '';
  try {
    const url = new URL(link);
    return url.pathname.split('/').filter(Boolean).pop();
  } catch {
    return link;
  }
};

const SearchPage = () => {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const pageParam = parseInt(searchParams.get('page'), 10) || 1;
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(pageParam);
  const [totalResults, setTotalResults] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [searchInput, setSearchInput] = useState(query);
  const [sortOption, setSortOption] = useState('relevance');
  const navigate = useNavigate();
  const location = useLocation();
  const isInitialRender = useRef(true);
  const resultsContainerRef = useRef(null);
  const [shouldRestoreScroll, setShouldRestoreScroll] = useState(false);
  
  // Check if we need to restore scroll position on mount
  useEffect(() => {
    const fromDetail = sessionStorage.getItem('fromDetailPage') === 'true';
    if (fromDetail) {
      setShouldRestoreScroll(true);
      // Only remove the flag after we've acknowledged it
      sessionStorage.removeItem('fromDetailPage');
    }
  }, []);
  
  // Track location changes to detect browser navigation
  useEffect(() => {
    // Reset scroll restoration flag when URL changes (except on initial render)
    if (!isInitialRender.current) {
      const savedQuery = sessionStorage.getItem('searchQuery');
      
      // If we're navigating to the same search query that we have saved,
      // we should restore the scroll position
      if (savedQuery === query) {
        setShouldRestoreScroll(true);
      }
    }
    
    isInitialRender.current = false;
  }, [location.key, query]);

  useEffect(() => {
    setCurrentPage(pageParam);
  }, [pageParam]);

  const search = async (query, page) => {
    if (!query) return;
    setLoading(true);
    try {
      const result = await searchDoujins(query, page);
      console.log('Search API Response:', result); // Debug log
      
      if (result && result.success && result.results) {
        setResults(result.results);
        
        // Check for totalPages info first (direct from API)
        if (result.totalPages !== undefined) {
          console.log('Found totalPages in search response:', result.totalPages);
          setTotalPages(result.totalPages);
          // Calculate total results from pages
          setTotalResults(result.totalPages * 20); // assuming 20 per page
        } 
        // Then check for total count
        else if (result.total !== undefined) {
          console.log('Found total count in search response:', result.total);
          setTotalResults(result.total);
          // Calculate pages from total
          setTotalPages(Math.ceil(result.total / 20));
        } 
        // Fallback to length if nothing else
        else {
          console.log('No pagination info in search response, using fallback');
          setTotalResults(result.results.length * 10); // Conservative estimate
          setTotalPages(Math.max(10, Math.ceil(result.results.length * 10 / 20))); // At least 10 pages
        }
      } else {
        // Even if search fails, set default pagination
        console.log('Search failed, using default pagination');
        setTotalResults(1000);
        setTotalPages(50);
        toast.error('Search failed');
      }
    } catch (error) {
      // Set default pagination even on error
      setTotalResults(1000);
      setTotalPages(50);
      toast.error('Error: ' + (error.message || 'Failed to connect to server'));
      console.error('Search error:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    search(query, currentPage);
  }, [query, currentPage]);

  // Restore scroll position after results are loaded
  useEffect(() => {
    if (!loading && results.length > 0 && shouldRestoreScroll) {
      const scrollPosition = sessionStorage.getItem('searchScroll');
      console.log(`Attempting to restore scroll position: ${scrollPosition}, shouldRestore: ${shouldRestoreScroll}`);
      
      if (scrollPosition) {
        // Use a longer delay to ensure all images are loaded
        console.log(`Will restore scroll to ${scrollPosition} in 300ms`);
        setTimeout(() => {
          window.scrollTo({
            top: parseInt(scrollPosition, 10),
            behavior: 'auto'
          });
          console.log(`Scroll position restored to ${scrollPosition}`);
          setShouldRestoreScroll(false);
        }, 300);
      } else {
        setShouldRestoreScroll(false);
      }
    }
  }, [loading, results, shouldRestoreScroll]);

  // Handle browser navigation events
  useEffect(() => {
    // Function to handle browser back/forward navigation
    const handleNavigation = () => {
      const scrollPosition = sessionStorage.getItem('searchScroll');
      if (scrollPosition) {
        setShouldRestoreScroll(true);
      }
    };

    // Listen for navigation events
    window.addEventListener('popstate', handleNavigation);
    
    return () => {
      window.removeEventListener('popstate', handleNavigation);
    };
  }, []);

  const handlePageChange = (page) => {
    // Save current state before changing page
    if (page !== currentPage) {
      sessionStorage.setItem('searchQuery', query);
      sessionStorage.setItem('searchPage', page.toString());
      // Don't save scroll position for pagination
      sessionStorage.removeItem('searchScroll');
    }
    
    setCurrentPage(page);
    navigate(`/search?q=${encodeURIComponent(query)}&page=${page}`);
    window.scrollTo(0, 0);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchInput.trim()) {
      // Clear previous search scroll position when performing a new search
      if (searchInput.trim() !== query) {
        sessionStorage.removeItem('searchScroll');
      }
      
      // Save the new search query
      sessionStorage.setItem('searchQuery', searchInput.trim());
      sessionStorage.setItem('searchPage', '1');
      
      // Navigate to the new search query
      navigate(`/search?q=${encodeURIComponent(searchInput.trim())}`);
      setCurrentPage(1);
    }
  };

  const handleSortChange = (e) => {
    setSortOption(e.target.value);
    // In a real implementation, you would re-fetch or re-sort results here
  };

  const toggleFilters = () => {
    setShowFilters(!showFilters);
  };

  // Animated appearance for results
  const resultsAppearance = {
    animation: 'fadeIn 0.5s ease-in-out',
  };

  // Add special handling for detecting when the user is on /detail/ path
  useEffect(() => {
    // Check if we're on a URL with just /detail/ without any slug
    // This would happen if the browser back navigation got stuck
    if (location.pathname === '/detail/') {
      console.log('Detected navigation to /detail/ base path, redirecting to search');
      
      // Try to get saved search data
      const searchQuery = sessionStorage.getItem('searchQuery');
      const searchPage = sessionStorage.getItem('searchPage');
      
      if (searchQuery) {
        // We have search data, redirect to search
        sessionStorage.setItem('fromDetailPage', 'true');
        navigate(`/search?q=${encodeURIComponent(searchQuery)}&page=${searchPage || '1'}`);
      } else {
        // No search data, redirect to home
        navigate('/');
      }
    }
  }, [location.pathname, navigate]);

  return (
    <div className="w-full mx-auto" ref={resultsContainerRef}>
      {/* Results Header */}
      <div className="flex flex-col md:flex-row justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center">
          <BookOpen className="h-7 w-7 mr-2 text-purple-600" />
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-purple-600 to-blue-500">
            Search Results
          </span>
        </h1>
        {!loading && results.length > 0 && (
          <p className="text-gray-600 mt-2 md:mt-0">
            Found <span className="font-bold text-purple-600">{totalResults}</span> results for "{query}"
          </p>
        )}
      </div>
      {/* Loading State */}
      {loading ? (
        <div className="grid place-items-center h-64">
          <div className="relative">
            <div className="h-16 w-16 rounded-full border-t-4 border-b-4 border-purple-600 animate-spin"></div>
            <div className="absolute top-0 left-0 h-16 w-16 rounded-full border-t-4 border-b-4 border-blue-500 animate-spin animate-ping opacity-50"></div>
          </div>
          <p className="mt-4 text-gray-600 font-medium">Searching for "{query}"...</p>
        </div>
      ) : results.length > 0 ? (
        <>
          {/* Results Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 w-full mx-auto">
            {results.map((result, index) => (
              <div 
                key={index} 
                className="animate-fade-in transition-transform hover:scale-105 cursor-pointer"
                style={{ animationDelay: `${index * 50}ms` }}
                onClick={() => {
                  // Store current scroll position before navigating
                  const currentScrollY = window.scrollY.toString();
                  sessionStorage.setItem('searchScroll', currentScrollY);
                  sessionStorage.setItem('searchQuery', query);
                  sessionStorage.setItem('searchPage', currentPage.toString());
                  sessionStorage.setItem('fromDetailPage', 'true');
                  
                  // Log for debugging
                  console.log(`Saved scroll position: ${currentScrollY} for query: ${query}`);
                  
                  // Navigate to detail page
                  navigate(`/detail/${getSlug(result.link)}`);
                }}
              >
                <DoujinCard
                  title={result.title}
                  link={result.link}
                  thumbnail={result.thumbnail || result.cover || result.image}
                  score={result.score || result.rating}
                  status={result.status || (result.completed !== undefined ? (result.completed ? 'Finished' : 'Ongoing') : '')}
                />
              </div>
            ))}
          </div>
          {/* Pagination - with debug info */}
          <div className="mt-12">
            {console.log('Rendering Search Pagination with:', { currentPage, totalResults, totalPages })}
            <Pagination 
              currentPage={currentPage} 
              onPageChange={handlePageChange}
              totalResults={totalResults}
              resultsPerPage={20}
            />
          </div>
        </>
      ) : (
        <div className="text-center py-20">
          <div className="bg-gray-100 rounded-lg p-10 max-w-lg mx-auto">
            <img 
              src="/api/placeholder/200/200" 
              alt="No results" 
              className="mx-auto w-24 h-24 mb-4 opacity-50"
            />
            <h3 className="text-xl font-bold text-gray-800 mb-2">No Results Found</h3>
            <p className="text-gray-600 mb-4">We couldn't find any matches for "{query}"</p>
            <div className="text-sm text-gray-500">
              <p className="mb-1">Try:</p>
              <ul className="list-disc pl-5 text-left">
                <li>Using more general keywords</li>
                <li>Checking for typos or misspellings</li>
                <li>Using fewer keywords</li>
              </ul>
            </div>
          </div>
        </div>
      )}
      {/* Add global CSS for animations */}
      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
      `}</style>
    </div>
  );
};

export default SearchPage;