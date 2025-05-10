import React, { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const Pagination = ({ currentPage, onPageChange, totalResults, resultsPerPage = 20 }) => {
  // Calculate total pages based on results and items per page
  const totalPages = Math.ceil(totalResults / resultsPerPage) || 1; // Ensure at least 1 page
  
  // Log for debugging
  useEffect(() => {
    console.log('Pagination component props:', { currentPage, totalResults, totalPages });
  }, [currentPage, totalResults]);
  
  // Don't show pagination if only one page or no results
  if (totalPages <= 1) {
    console.log('Pagination hidden - only one page or no results');
    return null;
  }
  
  // Determine which page numbers to show
  const getPageNumbers = () => {
    const pages = [];
    const maxVisiblePages = 7; // Increased from 5 to 7
    
    if (totalPages <= maxVisiblePages) {
      // If we have fewer pages than our maximum, show all pages
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always include page 1
      pages.push(1);
      
      // Calculate the range around the current page
      let startPage = Math.max(2, currentPage - 2);
      let endPage = Math.min(totalPages - 1, currentPage + 2);
      
      // Add ellipsis after page 1 if needed
      if (startPage > 2) {
        pages.push('...');
      }
      
      // Add the pages around the current page
      for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
      }
      
      // Add ellipsis before the last page if needed
      if (endPage < totalPages - 1) {
        pages.push('...');
      }
      
      // Always include the last page
      pages.push(totalPages);
    }
    
    return pages;
  };

  // Debug - log the pages that will be displayed
  const pageNumbers = getPageNumbers();
  console.log('Pages to display:', pageNumbers);

  return (
    <div className="flex flex-col items-center justify-center space-y-3">
      <div className="flex items-center justify-center space-x-1">
        {/* Previous page button */}
        <button
          onClick={() => currentPage > 1 && onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className={`flex items-center justify-center w-10 h-10 rounded-full ${
            currentPage === 1
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
          aria-label="Previous page"
        >
          <ChevronLeft size={20} />
        </button>
        
        {/* Page numbers */}
        {pageNumbers.map((page, index) => (
          <React.Fragment key={index}>
            {page === '...' ? (
              <span className="w-10 h-10 flex items-center justify-center text-gray-500">...</span>
            ) : (
              <button
                onClick={() => onPageChange(page)}
                className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  currentPage === page
                    ? 'bg-blue-600 text-white font-medium'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {page}
              </button>
            )}
          </React.Fragment>
        ))}
        
        {/* Next page button */}
        <button
          onClick={() => currentPage < totalPages && onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className={`flex items-center justify-center w-10 h-10 rounded-full ${
            currentPage === totalPages
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
          aria-label="Next page"
        >
          <ChevronRight size={20} />
        </button>
      </div>
      
      {/* Page info - always show total pages */}
      <div className="text-sm text-gray-500">
        Page {currentPage} of {totalPages} ({totalResults} results)
      </div>
    </div>
  );
};

export default Pagination;