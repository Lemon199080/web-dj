import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getDoujinDetail, getThumbnail } from '../services/api';
import { ArrowLeft, BookOpen, Calendar, Star, ChevronRight, Info, Clock, List, Eye } from 'lucide-react';

const DetailPage = () => {
  const { slug } = useParams();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const [hasSearchHistory, setHasSearchHistory] = useState(false);
  const [searchData, setSearchData] = useState({
    query: '',
    page: '1',
    hasData: false
  });
  const [activeTab, setActiveTab] = useState('chapters');

  // First effect: fix the history stack on component mount
  useEffect(() => {
    // This will run once when component mounts
    const searchQuery = sessionStorage.getItem('searchQuery');
    const searchPage = sessionStorage.getItem('searchPage');
    const searchScroll = sessionStorage.getItem('searchScroll');
    const isFromSearch = !!searchQuery && !!searchScroll;
    
    setHasSearchHistory(isFromSearch);
    
    if (isFromSearch) {
      // Store search data in component state for later use
      setSearchData({
        query: searchQuery,
        page: searchPage || '1',
        hasData: true
      });
      
      // Create the search URL that we'll use for navigating back
      const searchUrl = `/search?q=${encodeURIComponent(searchQuery)}&page=${searchPage || '1'}`;
      
      try {
        // Replace the history stack entry for the detail page with the search page
        if (window.history.state) {
          console.log('Manipulating history to fix back button navigation');
          
          // Save the current location
          const currentPath = window.location.pathname;
          
          // First replace current history entry with the search page
          window.history.replaceState(
            { ...window.history.state, from: 'search', searchUrl, key: 'search_override' }, 
            '', 
            searchUrl
          );
          
          // Then push the detail page back on so we stay on the detail page
          window.history.pushState(
            { from: 'detail', returnTo: searchUrl, key: 'detail_override' }, 
            '', 
            currentPath
          );
        }
      } catch (error) {
        console.error('Error manipulating history:', error);
      }
    }
  }, []);
  
  // Effect to load detail data
  useEffect(() => {
    const loadDetail = async () => {
      setLoading(true);
      try {
        const result = await getDoujinDetail(slug);
        if (result && result.success && result.detail) {
          setDetail(result.detail);
          
          // Load thumbnail
          if (result.detail.thumbnail) {
            try {
              const thumbResult = await getThumbnail(result.detail.thumbnail);
              setThumbnailUrl(thumbResult.cdnUrl || thumbResult.thumbnail || result.detail.thumbnail);
            } catch (e) {
              setThumbnailUrl(result.detail.thumbnail);
            }
          }
        } else {
          toast.error('Failed to load comic details');
        }
      } catch (error) {
        toast.error('Error: ' + (error.message || 'Failed to connect to server'));
        console.error('Error loading detail:', error);
      } finally {
        setLoading(false);
      }
    };

    if (slug) {
      loadDetail();
    }
  }, [slug]);

  // Listen for back button clicks
  useEffect(() => {
    const handlePopState = (e) => {
      console.log('popstate event in DetailPage', e.state);
      
      // Check if we have history state information
      if (e.state && e.state.from === 'search' && e.state.searchUrl) {
        // User clicked back, we're already on the right URL due to our history manipulation
        console.log('Back navigation detected, already on correct URL');
        sessionStorage.setItem('fromDetailPage', 'true');
      } else if (searchData.hasData) {
        // Fallback: we still have search data but history manipulation failed
        console.log('Back navigation using fallback');
        sessionStorage.setItem('fromDetailPage', 'true');
        
        // Replace current history entry and navigate
        const searchUrl = `/search?q=${encodeURIComponent(searchData.query)}&page=${searchData.page}`;
        navigate(searchUrl, { replace: true });
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [navigate, searchData]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (searchData.hasData) {
        sessionStorage.setItem('fromDetailPage', 'true');
      }
    };
  }, [searchData.hasData]);

  const getChapterSlug = (chapterLink) => {
    if (!chapterLink) return '';
    if (chapterLink.startsWith('http')) {
      try {
        const url = new URL(chapterLink);
        return url.pathname.split('/').filter(Boolean).join('/');
      } catch (e) {
        return chapterLink;
      }
    }
    return chapterLink;
  };

  const handleBackToSearch = () => {
    // Set the flag that we're returning from a detail page
    sessionStorage.setItem('fromDetailPage', 'true');
    
    // Use the search data we already have
    if (searchData.hasData) {
      const searchUrl = `/search?q=${encodeURIComponent(searchData.query)}&page=${searchData.page}`;
      navigate(searchUrl);
    } else {
      // Fallback to home if no search data
      navigate('/');
    }
  };
  
  // Function to start reading from the first chapter
  const startReading = () => {
    if (detail?.chapters && detail.chapters.length > 0) {
      // Store chapters for the read page
      sessionStorage.setItem('currentChapters', JSON.stringify(detail.chapters));
      
      // Navigate to the first chapter
      navigate(`/read${getChapterSlug(detail.chapters[0].chapterLink)}`);
    }
  };

  // Function to format date string to be more readable
  const formatDate = (dateString) => {
    if (!dateString) return '';
    
    try {
      // Try to parse date strings in various formats
      const date = new Date(dateString);
      if (!isNaN(date.getTime())) {
        return date.toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'short', 
          day: 'numeric' 
        });
      }
      return dateString;
    } catch (e) {
      return dateString;
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Top navigation */}
      <div className="sticky top-0 z-30 bg-gray-900 text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {hasSearchHistory ? (
              <button
                onClick={handleBackToSearch}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition-colors"
                aria-label="Back to Search"
              >
                <ArrowLeft size={18} />
                <span className="hidden sm:inline">Back to Search</span>
              </button>
            ) : (
              <Link 
                to="/"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition-colors"
              >
                <ArrowLeft size={18} />
                <span className="hidden sm:inline">Home</span>
              </Link>
            )}
            
            <div className="flex items-center gap-2 overflow-hidden max-w-[60%]">
              <BookOpen size={20} className="text-blue-400 flex-shrink-0" />
              <h1 className="text-lg font-medium truncate">
                {detail?.title || 'Comic Details'}
              </h1>
            </div>
            
            {!loading && detail?.chapters && detail.chapters.length > 0 && (
              <button
                onClick={startReading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 transition-colors whitespace-nowrap"
              >
                <Eye size={18} />
                <span className="hidden sm:inline">Start Reading</span>
              </button>
            )}
          </div>
        </div>
      </div>
      
      {loading ? (
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <div className="relative">
            <div className="h-16 w-16 rounded-full border-t-4 border-b-4 border-purple-600 animate-spin"></div>
            <div className="absolute top-0 left-0 h-16 w-16 rounded-full border-t-4 border-b-4 border-blue-500 animate-spin animate-ping opacity-50"></div>
          </div>
          <p className="mt-6 text-gray-600">Loading comic details...</p>
        </div>
      ) : detail ? (
        <div className="max-w-6xl mx-auto px-4 py-6">
          {/* Comic Header Area */}
          <div className="bg-white rounded-xl shadow-md overflow-hidden mb-6">
            <div className="bg-gradient-to-r from-blue-500 to-purple-600 h-40 relative">
              {/* Blurred background image if available */}
              {thumbnailUrl && (
                <div 
                  className="absolute inset-0 opacity-20" 
                  style={{
                    backgroundImage: `url(${thumbnailUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    filter: 'blur(20px)'
                  }}
                ></div>
              )}
              
              {/* Overlay gradient */}
              <div className="absolute inset-0 bg-gradient-to-t from-blue-900 to-transparent opacity-70"></div>
              
              {/* Content positioned at bottom */}
              <div className="absolute bottom-0 left-0 right-0 p-6 text-white">
                <h1 className="text-2xl sm:text-3xl font-bold leading-tight truncate">
                  {detail.title || 'Untitled Comic'}
                </h1>
              </div>
            </div>
            
            <div className="p-6 md:flex">
              {/* Thumbnail Column */}
              <div className="md:w-1/3 lg:w-1/4 flex-shrink-0 md:pr-6">
                <div className="bg-gray-200 rounded-lg overflow-hidden shadow-md -mt-20 md:-mt-28 relative z-10 aspect-[3/4] max-w-[250px] mx-auto md:mx-0">
                  <img
                    src={thumbnailUrl || '/placeholder.jpg'}
                    alt={detail.title}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = '/placeholder.jpg';
                    }}
                  />
                </div>
                
                {/* Status Badges */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {detail.rating && (
                    <div className="flex items-center gap-1 bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full text-sm">
                      <Star size={16} className="fill-yellow-500 text-yellow-500" />
                      <span className="font-medium">{detail.rating}</span>
                    </div>
                  )}
                  
                  {detail.status && (
                    <div className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm">
                      {detail.status}
                    </div>
                  )}
                  
                  {detail.type && (
                    <div className="bg-purple-100 text-purple-800 px-3 py-1 rounded-full text-sm">
                      {detail.type}
                    </div>
                  )}
                </div>
                
                {/* Metadata Info on Mobile */}
                <div className="mt-4 md:hidden space-y-3">
                  {detail.author && (
                    <div>
                      <p className="text-gray-500 text-sm">Author</p>
                      <p className="font-medium">{detail.author}</p>
                    </div>
                  )}
                  
                  {detail.updatedAt && (
                    <div className="flex items-start gap-2">
                      <Clock size={18} className="text-gray-400 mt-0.5" />
                      <div>
                        <p className="text-gray-500 text-sm">Updated</p>
                        <p>{formatDate(detail.updatedAt)}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Info Column */}
              <div className="md:w-2/3 lg:w-3/4 mt-6 md:mt-0">
                {/* Desktop Metadata */}
                <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
                  {detail.author && (
                    <div>
                      <p className="text-gray-500 text-sm">Author</p>
                      <p className="font-medium">{detail.author}</p>
                    </div>
                  )}
                  
                  {detail.artist && (
                    <div>
                      <p className="text-gray-500 text-sm">Artist</p>
                      <p className="font-medium">{detail.artist}</p>
                    </div>
                  )}
                  
                  {detail.updatedAt && (
                    <div>
                      <p className="text-gray-500 text-sm">Updated</p>
                      <p className="font-medium">{formatDate(detail.updatedAt)}</p>
                    </div>
                  )}
                  
                  {detail.releaseDate && (
                    <div>
                      <p className="text-gray-500 text-sm">Released</p>
                      <p className="font-medium">{formatDate(detail.releaseDate)}</p>
                    </div>
                  )}
                  
                  {detail.chapters && detail.chapters.length > 0 && (
                    <div>
                      <p className="text-gray-500 text-sm">Chapters</p>
                      <p className="font-medium">{detail.chapters.length}</p>
                    </div>
                  )}
                </div>
                
                {/* Genres */}
                {detail.genres && detail.genres.length > 0 && (
                  <div className="mb-6">
                    <p className="text-gray-500 text-sm mb-2">Genres</p>
                    <div className="flex flex-wrap gap-2">
                      {detail.genres.map((genre, index) => (
                        <span
                          key={index}
                          className="bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-800 border border-blue-200 px-3 py-1 rounded-full text-sm"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Description if available */}
                {detail.description && (
                  <div className="mb-6">
                    <p className="text-gray-500 text-sm mb-2">Synopsis</p>
                    <p className="text-gray-700 leading-relaxed">
                      {detail.description}
                    </p>
                  </div>
                )}
                
                {/* Call to action buttons */}
                <div className="flex flex-wrap gap-3 mt-6">
                  {detail.chapters && detail.chapters.length > 0 && (
                    <button
                      onClick={startReading}
                      className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-all shadow-md hover:shadow-lg"
                    >
                      <Eye size={20} />
                      Start Reading
                    </button>
                  )}
                  
                  {detail.externalLink && (
                    <a
                      href={detail.externalLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300 transition-all"
                    >
                      <Info size={18} />
                      Source
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          {/* Tabs for Chapters/Comments */}
          <div className="mb-4 border-b border-gray-200">
            <div className="flex space-x-8">
              <button
                onClick={() => setActiveTab('chapters')}
                className={`pb-4 px-1 font-medium text-sm sm:text-base flex items-center gap-2 ${
                  activeTab === 'chapters'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <List size={18} />
                Chapters
              </button>
              <button
                onClick={() => setActiveTab('info')}
                className={`pb-4 px-1 font-medium text-sm sm:text-base flex items-center gap-2 ${
                  activeTab === 'info'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Info size={18} />
                Information
              </button>
            </div>
          </div>
          
          {/* Content based on active tab */}
          {activeTab === 'chapters' && (
            <div className="bg-white rounded-xl shadow-md p-4">
              {detail.chapters && detail.chapters.length > 0 ? (
                <div className="divide-y divide-gray-100">
                  {detail.chapters.map((chapter, index) => (
                    <Link
                      to={`/read${getChapterSlug(chapter.chapterLink)}`}
                      key={index}
                      className="block py-4 px-3 transition-colors hover:bg-blue-50 rounded-lg mb-1"
                      onClick={() => {
                        sessionStorage.setItem('currentChapters', JSON.stringify(detail.chapters));
                      }}
                    >
                      <div className="flex justify-between items-center">
                        <div className="pr-4">
                          <h3 className="font-medium text-gray-900 flex items-center">
                            {chapter.chapterTitle || chapter.chapterName || `Chapter ${index + 1}`}
                          </h3>
                          {chapter.chapterName && chapter.chapterName !== chapter.chapterTitle && (
                            <p className="text-gray-600 text-sm">{chapter.chapterName}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {chapter.chapterDate && (
                            <span className="text-gray-500 text-sm whitespace-nowrap">
                              {formatDate(chapter.chapterDate)}
                            </span>
                          )}
                          <ChevronRight size={20} className="text-gray-400" />
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center text-gray-500">
                  <p>No chapters available</p>
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'info' && (
            <div className="bg-white rounded-xl shadow-md p-6">
              <h3 className="text-xl font-semibold mb-4">Comic Information</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {detail.author && (
                  <div>
                    <p className="text-gray-500 text-sm">Author</p>
                    <p className="font-medium">{detail.author}</p>
                  </div>
                )}
                
                {detail.artist && (
                  <div>
                    <p className="text-gray-500 text-sm">Artist</p>
                    <p className="font-medium">{detail.artist}</p>
                  </div>
                )}
                
                {detail.status && (
                  <div>
                    <p className="text-gray-500 text-sm">Status</p>
                    <p className="font-medium">{detail.status}</p>
                  </div>
                )}
                
                {detail.releaseDate && (
                  <div>
                    <p className="text-gray-500 text-sm">Released</p>
                    <p className="font-medium">{formatDate(detail.releaseDate)}</p>
                  </div>
                )}
                
                {detail.updatedAt && (
                  <div>
                    <p className="text-gray-500 text-sm">Last Updated</p>
                    <p className="font-medium">{formatDate(detail.updatedAt)}</p>
                  </div>
                )}
                
                {detail.publisher && (
                  <div>
                    <p className="text-gray-500 text-sm">Publisher</p>
                    <p className="font-medium">{detail.publisher}</p>
                  </div>
                )}
                
                {detail.rating && (
                  <div>
                    <p className="text-gray-500 text-sm">Rating</p>
                    <div className="flex items-center gap-1 mt-1">
                      <Star size={18} className="fill-yellow-500 text-yellow-500" />
                      <span className="font-medium">{detail.rating}</span>
                    </div>
                  </div>
                )}
                
                {detail.chapters && (
                  <div>
                    <p className="text-gray-500 text-sm">Chapters</p>
                    <p className="font-medium">{detail.chapters.length}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <div className="bg-white shadow-md rounded-lg max-w-md w-full p-8 text-center">
            <div className="text-gray-400 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-700 mb-2">Comic Not Found</h2>
            <p className="text-gray-500 mb-6">
              Sorry, we couldn't find the comic you're looking for.
            </p>
            <Link to="/" className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors">
              Return to Home
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default DetailPage;