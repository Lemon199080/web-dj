import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getThumbnail } from '../services/api';

const DoujinCard = ({ title, thumbnail, slug, type, chapter, time }) => {
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const fallbackSvg = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiNlZWVlZWUiLz48dGV4dCB4PSI1MCUiIHk9Ij50JSIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjEyIiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tm8gSW1hZ2U8L3RleHQ+PC9zdmc+';

  useEffect(() => {
    const loadThumbnail = async () => {
      if (!thumbnail) {
        setImageUrl(fallbackSvg);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const result = await getThumbnail(thumbnail);
        setImageUrl(result?.cdnUrl || fallbackSvg);
        setImageError(false);
      } catch (error) {
        console.error('Error loading thumbnail:', error);
        setImageUrl(fallbackSvg);
        setImageError(true);
      } finally {
        setLoading(false);
      }
    };

    loadThumbnail();
  }, [thumbnail]);

  const getSlug = () => {
    if (!slug) return '';
    if (slug.startsWith('http')) {
      try {
        const url = new URL(slug);
        return url.pathname.split('/').filter(Boolean).pop();
      } catch (e) {
        return slug;
      }
    }
    return slug;
  };

  const handleImageError = () => {
    if (!imageError) {
      setImageError(true);
      setImageUrl(fallbackSvg);
    }
  };

  return (
    <div
      className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-xl hover:scale-105 transition-all duration-300"
      role="article"
      aria-label={`Comic card: ${title || 'Untitled'}`}
    >
      {type && (
        <span className="absolute top-2 left-2 bg-blue-500 text-white text-xs font-semibold px-1.5 py-0.5 rounded">
          {type}
        </span>
      )}

      <Link to={`/detail/${getSlug()}`} className="block">
        <div className="relative bg-gray-200" style={{ aspectRatio: '3/4' }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-300">
              <div className="animate-spin rounded-full h-5 w-5 sm:h-6 sm:w-6 border-t-2 border-blue-500"></div>
            </div>
          ) : (
            <img
              src={imageUrl}
              alt={title || 'Comic thumbnail'}
              className="w-full h-full object-cover"
              onError={handleImageError}
              loading="lazy"
            />
          )}
        </div>

        <div className="p-2 sm:p-4">
          <h3
            className="font-semibold text-gray-800 text-xs sm:text-sm line-clamp-2 h-8 sm:h-10"
            title={title}
          >
            {title || 'Untitled'}
          </h3>
          <div className="flex justify-between items-center mt-1 sm:mt-2 text-xs text-gray-500">
            {chapter && <span>{chapter}</span>}
            {time && <span>{time}</span>}
          </div>
        </div>
      </Link>
    </div>
  );
};

export default DoujinCard;