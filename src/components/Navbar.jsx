import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';

const Navbar = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <nav className="bg-gray-800 text-white shadow-md">
      <div className="container mx-auto px-4 py-3 flex flex-col md:flex-row items-center justify-between">
        <div className="flex items-center">
          <Link to="/" className="text-xl font-bold">DoujinReader</Link>
        </div>

        <form onSubmit={handleSearch} className="flex mt-2 md:mt-0 w-full md:w-auto">
          <input
            type="text"
            placeholder="Search comics..."
            className="px-4 py-1 rounded-l text-black flex-grow md:w-64"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button type="submit" className="bg-blue-600 px-3 py-1 rounded-r flex items-center">
            <Search size={18} />
          </button>
        </form>
      </div>
    </nav>
  );
};

export default Navbar;
