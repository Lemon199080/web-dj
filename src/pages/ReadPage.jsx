import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ChevronUp, ChevronDown, Home, Settings, X, ArrowLeft, ArrowRight, Menu } from 'lucide-react';
import { getDoujinImages } from '../services/api';
import { useLocation } from 'react-router-dom';

const ReadPage = () => {
  // Add CSS reset for body and html to ensure full width
  // Add CSS to override global styles
  useEffect(() => {
    // Create a style element
    const styleEl = document.createElement('style');
    // Add CSS that specifically overrides any constraints on image width
    styleEl.textContent = `
      .manga-reader-fullwidth {
        width: 100vw !important;
        max-width: 100vw !important;
        margin: 0 !important;
        padding: 0 !important;
        box-sizing: border-box !important;
      }
      .manga-reader-fullwidth img {
        width: 100vw !important;
        max-width: 100vw !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      body, html {
        margin: 0 !important;
        padding: 0 !important;
        overflow-x: hidden !important;
        background-color: #111827 !important;
      }
      .container {
        max-width: 100vw !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .page-controls {
        transition: opacity 0.3s ease;
      }
      .page-controls:hover {
        opacity: 1 !important;
      }
    `;
    // Add the style element to the document head
    document.head.appendChild(styleEl);
    
    return () => {
      // Clean up by removing the style element when component unmounts
      document.head.removeChild(styleEl);
    };
  }, []);
  const location = useLocation();
  const slug = location.pathname.replace('/read/', '');
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [showNav, setShowNav] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [readingMode, setReadingMode] = useState(
    localStorage.getItem('readingMode') || 'vertical'
  );
  const imageRefs = useRef([]);
  const [chapterList, setChapterList] = useState([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(-1);
  const navigate = useNavigate();

  useEffect(() => {
    const loadImages = async () => {
      setLoading(true);
      try {
        const result = await getDoujinImages(slug);
        if (result && result.success && result.images) {
          setImages(result.images);
        } else {
          toast.error('Failed to load comic images');
        }
      } catch (error) {
        toast.error('Error: ' + (error.message || 'Failed to connect to server'));
        console.error('Error loading images:', error);
      } finally {
        setLoading(false);
      }
    };

    if (slug) {
      loadImages();
    }
  }, [slug]);

  useEffect(() => {
    localStorage.setItem('readingMode', readingMode);
  }, [readingMode]);

  useEffect(() => {
    // Fetch chapter list from sessionStorage (set in DetailPage)
    const chapters = JSON.parse(sessionStorage.getItem('currentChapters') || '[]');
    setChapterList(chapters);
    // Find current chapter index
    const idx = chapters.findIndex(ch => ch.chapterLink && slug.endsWith(ch.chapterLink.replace(/^\//, '')));
    setCurrentChapterIndex(idx);
  }, [slug]);

  const handleNextPage = () => {
    if (currentPage < images.length - 1) {
      setCurrentPage((prev) => prev + 1);
      if (readingMode === 'paged') {
        imageRefs.current[currentPage + 1]?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const handlePrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage((prev) => prev - 1);
      if (readingMode === 'paged') {
        imageRefs.current[currentPage - 1]?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      handleNextPage();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      handlePrevPage();
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentPage, images.length]);

  const handleImageError = (e, index, retries = 2) => {
    if (retries > 0) {
      setTimeout(() => {
        e.target.src = images[index];
      }, 1000);
    } else {
      e.target.onerror = null;
      e.target.src = '/placeholder.jpg';
      toast.error(`Failed to load image ${index + 1}`);
    }
  };

  // Function to navigate to next or previous chapter
  const navigateToChapter = (direction) => {
    if (direction === 'next' && currentChapterIndex < chapterList.length - 1) {
      navigate(`/read/${chapterList[currentChapterIndex + 1].chapterLink.replace(/^\//, '')}`);
    } else if (direction === 'prev' && currentChapterIndex > 0) {
      navigate(`/read/${chapterList[currentChapterIndex - 1].chapterLink.replace(/^\//, '')}`);
    }
  };

  // Determine if we should show chapter navigation buttons
  const showChapterNav = chapterList.length > 1 && currentChapterIndex !== -1;

  return (
    <div className="min-h-screen bg-gray-900 text-white manga-reader-fullwidth">
      {/* Top Navigation */}
      <div
        className={`fixed top-0 left-0 right-0 z-10 p-4 transition-all duration-300 bg-gray-800 bg-opacity-95 shadow-md ${
          showNav ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        role="navigation"
        aria-label="Main navigation"
      >
        <div className="flex justify-between items-center">
          <Link to="/" className="flex items-center gap-2" aria-label="Go to home page">
            <Home size={20} />
            <span>Home</span>
          </Link>

          <div className="flex items-center gap-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings(!showSettings);
              }}
              className="p-2 hover:bg-gray-700 rounded-full transition-colors"
              aria-label="Toggle settings"
            >
              <Settings size={20} />
            </button>
            
            {showChapterNav && (
              <div className="flex items-center gap-2">
                <button
                  className="flex items-center justify-center px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:hover:bg-blue-600"
                  disabled={currentChapterIndex <= 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateToChapter('prev');
                  }}
                  aria-label="Previous Chapter"
                >
                  <span className="text-xl">←</span>
                </button>
                <span className="text-sm opacity-75">
                  {currentChapterIndex + 1} / {chapterList.length}
                </span>
                <button
                  className="flex items-center justify-center px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:hover:bg-blue-600"
                  disabled={currentChapterIndex >= chapterList.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateToChapter('next');
                  }}
                  aria-label="Next Chapter"
                >
                  <span className="text-xl">→</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Menu Toggle Button (Always Visible) */}
      <button 
        onClick={(e) => {
          e.stopPropagation();
          setShowNav(true);
        }}
        className={`fixed top-4 right-4 z-20 p-2 bg-gray-800 bg-opacity-75 rounded-full shadow-lg transition-opacity duration-200 ${showNav ? 'opacity-0' : 'opacity-75 hover:opacity-100'}`}
        aria-label="Show menu"
      >
        <Menu size={20} />
      </button>

      {/* Settings Panel */}
      {showSettings && (
        <div 
          className="fixed top-16 right-4 w-64 max-w-[90vw] bg-gray-800 p-4 rounded-lg shadow-lg z-20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-medium">Reading Settings</h3>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings(false);
              }} 
              className="hover:bg-gray-700 p-1 rounded-full transition-colors"
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm">Reading Mode</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setReadingMode('vertical')}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
                    readingMode === 'vertical'
                      ? 'bg-blue-600'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                  aria-pressed={readingMode === 'vertical'}
                >
                  Vertical
                </button>
                <button
                  onClick={() => setReadingMode('paged')}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
                    readingMode === 'paged'
                      ? 'bg-blue-600'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                  aria-pressed={readingMode === 'paged'}
                >
                  Paged
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content Area */}
      <div
        className="relative min-h-screen w-full m-0 p-0"
        onClick={() => setShowNav(!showNav)}
        role="main"
        aria-label="Comic reader"
      >
        {loading ? (
          <div className="grid place-items-center h-screen">
            <div
              className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"
              role="status"
              aria-label="Loading"
            ></div>
          </div>
        ) : images.length > 0 ? (
          readingMode === 'vertical' ? (
            <div className="manga-reader-fullwidth">
              {images.map((image, index) => (
                <div key={index} ref={(el) => (imageRefs.current[index] = el)} className="manga-reader-fullwidth">
                  <img
                    src={image}
                    alt={`Page ${index + 1}`}
                    className="manga-reader-fullwidth"
                    onError={(e) => handleImageError(e, index)}
                    loading="lazy"
                    aria-label={`Comic page ${index + 1}`}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="h-screen flex flex-col items-center justify-center manga-reader-fullwidth">
              <img
                src={images[currentPage]}
                alt={`Page ${currentPage + 1}`}
                className="max-h-screen manga-reader-fullwidth"
                onError={(e) => handleImageError(e, currentPage)}
                aria-label={`Comic page ${currentPage + 1}`}
              />
              <div className="absolute bottom-4 left-0 right-0 text-center">
                <span className="bg-gray-800 bg-opacity-80 px-3 py-1 rounded-full text-sm">
                  {currentPage + 1} / {images.length}
                </span>
              </div>
            </div>
          )
        ) : (
          <div className="grid place-items-center h-screen">
            <div className="text-center">
              <p className="mb-4">No images found for this comic</p>
              <Link to="/" className="text-blue-400 underline" aria-label="Return to home page">
                Return to home page
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Mobile-friendly Floating Chapter Navigation (only shown when there are multiple chapters) */}
      {showNav && showChapterNav && (
        <div className="fixed left-1/2 bottom-8 transform -translate-x-1/2 z-30 flex flex-row gap-3 items-center md:hidden">
          <button
            className="flex items-center justify-center w-12 h-12 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-all duration-200 disabled:opacity-50"
            disabled={currentChapterIndex >= chapterList.length - 1}
            onClick={(e) => {
              e.stopPropagation();
              navigateToChapter('next');
            }}
            aria-label="Next Chapter"
          >
            <span className="text-xl font-bold">←</span>
          </button>
          <button
            className="flex items-center justify-center w-12 h-12 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-all duration-200 disabled:opacity-50"
            disabled={currentChapterIndex <= 0}
            onClick={(e) => {
              e.stopPropagation();
              navigateToChapter('prev');
            }}
            aria-label="Previous Chapter"
          >
            <span className="text-xl font-bold">→</span>
          </button>
        </div>
      )}

      {/* Navigation Controls for Paged Reading Mode */}
      {readingMode === 'paged' && images.length > 0 && (
        <div className="page-controls opacity-75">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handlePrevPage();
            }}
            disabled={currentPage <= 0}
            className="fixed left-4 top-1/2 transform -translate-y-1/2 bg-gray-800 bg-opacity-80 p-3 rounded-full disabled:opacity-30 enabled:hover:bg-gray-700 transition-colors focus:outline-none"
            aria-label="Previous page"
          >
            <ChevronUp size={24} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleNextPage();
            }}
            disabled={currentPage >= images.length - 1}
            className="fixed right-4 top-1/2 transform -translate-y-1/2 bg-gray-800 bg-opacity-80 p-3 rounded-full disabled:opacity-30 enabled:hover:bg-gray-700 transition-colors focus:outline-none"
            aria-label="Next page"
          >
            <ChevronDown size={24} />
          </button>
        </div>
      )}
    </div>
  );
};

export default ReadPage;