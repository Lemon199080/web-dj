import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Navbar from './components/Navbar';
import HomePage from './pages/HomePage';
import DetailPage from './pages/DetailPage';
import ReadPage from './pages/ReadPage';
import SearchPage from './pages/SearchPage';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <Toaster position="top-center" />
        <Navbar />
        <main className="container mx-auto px-4 py-4">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/detail/:slug" element={<DetailPage />} />
            <Route path="/read/*" element={<ReadPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;