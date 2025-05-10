const API_BASE_URL = 'https://api.zeds.rocks'; // Change this to your API URL

export const fetchDoujins = async (page = 1) => {
  try {
    const response = await fetch(`${API_BASE_URL}/doujin?page=${page}`);
    if (!response.ok) throw new Error('Failed to fetch doujins');
    return await response.json();
  } catch (error) {
    console.error('Error fetching doujins:', error);
    throw error;
  }
};

export const searchDoujins = async (query, page = 1) => {
  try {
    const response = await fetch(`${API_BASE_URL}/search?q=${encodeURIComponent(query)}&page=${page}`);
    if (!response.ok) throw new Error('Failed to search doujins');
    return await response.json();
  } catch (error) {
    console.error('Error searching doujins:', error);
    throw error;
  }
};

export const getDoujinDetail = async (slug) => {
  try {
    const response = await fetch(`${API_BASE_URL}/detail?url=${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error('Failed to fetch doujin details');
    return await response.json();
  } catch (error) {
    console.error('Error fetching doujin details:', error);
    throw error;
  }
};

export const getDoujinImages = async (slug) => {
  try {
    const response = await fetch(`${API_BASE_URL}/get-comic?url=${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error('Failed to fetch doujin images');
    return await response.json();
  } catch (error) {
    console.error('Error fetching doujin images:', error);
    throw error;
  }
};

export const getThumbnail = async (url) => {
  try {
    const response = await fetch(`${API_BASE_URL}/get?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch thumbnail: ${response.statusText}`);
    }
    
    const data = await response.json();

    // Optional: validasi format response
    if (!data || !data.cdnUrl) {
      throw new Error('Invalid thumbnail response format');
    }

    return data;
  } catch (error) {
    console.error('Error fetching thumbnail:', error.message || error);
    
    // Masih fallback tapi dalam bentuk konsisten
    return { cdnUrl: url, fallback: true };
  }
};
