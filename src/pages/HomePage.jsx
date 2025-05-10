import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { BookOpen, RefreshCw, Filter, Search } from 'lucide-react';
import DoujinCard from '../components/DoujinCard';
import Pagination from '../components/Pagination';
import { fetchDoujins } from '../services/api';

const HomePage = () => {
  const [doujins, setDoujins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [totalResults, setTotalResults] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const navigate = useNavigate();

  const loadDoujins = async (page) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDoujins(page);
      console.log('API Response:', result);
      
      if (result && result.data) {
        setDoujins(result.data);
        // Check if total pages info is available
        if (result.totalPages) {
          console.log('Total Pages from API:', result.totalPages);
          setTotalPages(result.totalPages);
          // Calculate approximate total results based on total pages
          setTotalResults(result.totalPages * 20); // Assuming 20 items per page
        } else if (result.total) {
          // If total results is provided directly
          console.log('Total Results from API:', result.total);
          setTotalResults(result.total);
          setTotalPages(Math.ceil(result.total / 20));
        } else {
          // Fallback
          console.log('No pagination info found, using fallback values');
          setTotalResults(result.data.length * 5); // Just a guess for pagination
          setTotalPages(5);
        }
      } else if (result && result.status === 'success') {
        setDoujins(result);
        // Handle different response format
        if (result.totalPages) {
          console.log('Total Pages from API (success format):', result.totalPages);
          setTotalPages(result.totalPages);
          setTotalResults(result.totalPages * 20);
        } else if (result.total) {
          console.log('Total Results from API (success format):', result.total);
          setTotalResults(result.total);
          setTotalPages(Math.ceil(result.total / 20));
        } else {
          console.log('No pagination info found in success format, using fallback values');
          setTotalResults(1000); // Fallback
          setTotalPages(50);
        }
      } else {
        throw new Error('Failed to load comics');
      }
    } catch (error) {
      setError(error.message || 'Failed to connect to server');
      toast.error(`Error: ${error.message || 'Failed to connect to server'}`);
      console.error('Error loading doujins:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDoujins(currentPage);
  }, [currentPage]);

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleRetry = () => {
    loadDoujins(currentPage);
  };

  // Navigation to detail page, mimicking SearchPage
  const handleComicClick = (slug) => {
    navigate(`/detail/${slug}`);
  };

  const filteredDoujins = doujins.filter((doujin) =>
    doujin.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white shadow-md">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <BookOpen className="text-blue-600" size={24} />
            <h1 className="text-2xl font-bold text-gray-900">MangaReader</h1>
          </div>

          <div className="relative flex-1 max-w-md mx-4">
            <div
              className={`flex items-center rounded-full border ${
                isSearchFocused ? 'border-blue-500 ring-2 ring-blue-100' : 'border-gray-300'
              } bg-white overflow-hidden px-3 py-2`}
            >
              <Search size={18} className="text-gray-400" />
              <input
                type="text"
                placeholder="Search comics..."
                className="w-full ml-2 outline-none text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onFocus={() => setIsSearchFocused(true)}
                onBlur={() => setIsSearchFocused(false)}
              />
            </div>
          </div>

          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center space-x-1 text-gray-700 hover:text-blue-600 transition p-2 rounded-full hover:bg-gray-100"
          >
            <Filter size={18} />
            <span className="hidden sm:inline text-sm">Filters</span>
          </button>
        </div>

        {showFilters && (
          <div className="container mx-auto px-4 py-3 bg-white border-t border-gray-100">
            <div className="flex flex-wrap gap-2">
              <button className="px-3 py-1 text-xs rounded-full bg-blue-100 text-blue-800 hover:bg-blue-200 transition">
                All
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                Manga
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                Manhwa
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                Manhua
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                Popular
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                New Releases
              </button>
              <button className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition">
                Completed
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="container mx-auto px-0 py-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-800">
            {searchTerm ? 'Search Results' : 'Latest Comics'}
          </h2>
          {currentPage > 1 && (
            <button
              onClick={() => handlePageChange(1)}
              className="text-sm text-blue-600 hover:text-blue-800 flex items-center"
            >
              Back to latest
            </button>
          )}
        </div>

        {error ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <div className="inline-flex justify-center items-center w-12 h-12 rounded-full bg-red-100 mb-4">
              <RefreshCw size={20} className="text-red-600" />
            </div>
            <p className="text-red-600 mb-4">{error}</p>
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition flex items-center justify-center mx-auto"
            >
              <RefreshCw size={16} className="mr-2" /> Retry
            </button>
          </div>
        ) : loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
            {Array(10)
              .fill()
              .map((_, index) => (
                <div
                  key={index}
                  className="bg-white rounded-lg shadow-sm overflow-hidden animate-pulse"
                  style={{ aspectRatio: '3/4' }}
                >
                  <div className="h-5/6 w-full bg-gray-200"></div>
                  <div className="p-3">
                    <div className="h-4 bg-gray-200 rounded mb-2"></div>
                    <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                  </div>
                </div>
              ))}
          </div>
        ) : filteredDoujins.length > 0 ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
              {filteredDoujins.map((doujin, index) => (
                <div
                  key={index}
                  className="animate-fade-in transition-transform hover:scale-105 cursor-pointer"
                  style={{ animationDelay: `${index * 50}ms` }}
                  onClick={() =>
                    handleComicClick(
                      doujin.link || doujin.title?.toLowerCase().replace(/\s+/g, '-') // Mimic SearchPage's use of result.link
                    )
                  }
                >
                  <DoujinCard
                    title={doujin.title}
                    link={doujin.link}
                    thumbnail={doujin.thumbnail || doujin.cover || doujin.image}
                    score={doujin.score || doujin.rating}
                    status={doujin.status || (doujin.completed !== undefined ? (doujin.completed ? 'Finished' : 'Ongoing') : '')}
                  />
                </div>
              ))}
            </div>
            <div className="mt-8">
              {console.log('Rendering Pagination with:', { currentPage, totalResults, totalPages })}
              <Pagination 
                currentPage={currentPage} 
                onPageChange={handlePageChange} 
                totalResults={totalResults}
                resultsPerPage={20}
              />
            </div>
          </>
        ) : (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <div className="inline-flex justify-center items-center w-12 h-12 rounded-full bg-gray-100 mb-4">
              <Search size={20} className="text-gray-400" />
            </div>
            <p className="text-gray-600">
              {searchTerm ? 'No comics found matching your search' : 'No comics available'}
            </p>
          </div>
        )}
      </div>

      <footer className="bg-white border-t border-gray-200 py-6 mt-8">
        <div className="container mx-auto px-4 text-center text-sm text-gray-500">
          <p>© {new Date().getFullYear()} MangaReader. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

// CSS for fade-in animation
const styles = `
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-in {
    animation: fade-in 0.3s ease-out forwards;
  }
  
  /* Add smooth hover transitions */
  .transition {
    transition: all 0.2s ease-in-out;
  }
`;

// Inject styles
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);
}

export default HomePage;