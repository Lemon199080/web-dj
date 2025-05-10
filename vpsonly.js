const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const NodeCache = require('node-cache');
const compression = require('compression');
const AbortController = require('abort-controller');
const { Readable } = require('stream');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import database and R2 upload functions
const { sql } = require('./config.js');
const { uploadToR2 } = require('./uploadToR2.js');

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 5000;

// Increased cache duration for better performance
const cache = new NodeCache({ stdTTL: 1800 }); // Cache for 30 minutes

// Middleware
app.use(cors());
app.use(compression({
  level: 6, // Higher compression level
  threshold: 0 // Compress all responses
}));
app.use(express.json({ limit: '1mb' })); // Limit payload size

// Configuration with optimized browser settings
const CONFIG = {
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions'
  ],
  defaultViewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
  timeout: 15000
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://doujindesu.tv/',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Constants
const urlBase = 'https://doujindesu.tv/';
const DEFAULT_TIMEOUT = 10000; // Default timeout for page operations

// Browser Pool
let browserPool = [];
const POOL_SIZE = 3; // Reduced pool size for lower memory usage
let isPoolInitialized = false;

// Improved timeout and abort handling
const createTimeout = (ms) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try {
      controller.abort();
    } catch (e) {
      console.error('Error aborting request:', e);
    }
  }, ms);
  return { controller, timeout };
};

const initBrowserPool = async () => {
  if (isPoolInitialized) return;
  
  for (let i = 0; i < POOL_SIZE; i++) {
    try {
      const browser = await puppeteer.launch(CONFIG);
      browserPool.push(browser);
    } catch (error) {
      console.error('Failed to initialize browser:', error);
    }
  }
  
  isPoolInitialized = true;
  console.log(`??? Browser pool initialized (${browserPool.length} instances)`);
};

const getBrowser = async () => {
  if (!isPoolInitialized) await initBrowserPool();
  
  while (browserPool.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return browserPool.pop();
};

const releaseBrowser = (browser) => {
  if (browserPool.length < POOL_SIZE) {
    browserPool.push(browser);
  } else {
    browser.close().catch(console.error);
  }
};

// Regularly restart browsers to prevent memory leaks
setInterval(() => {
  console.log('?? Refreshing browser pool...');
  
  Promise.all(browserPool.map(browser => browser.close()))
    .catch(console.error)
    .finally(() => {
      browserPool = [];
      isPoolInitialized = false;
      initBrowserPool();
    });
}, 1000 * 60 * 60); // Every hour

// Helpers
const isValidUrl = (url) => {
  const regex = /^(https?:\/\/)?(www\.)?doujindesu\.tv\/doujin\/page\/\d+\/$/;
  return regex.test(url);
};

const isValidSlug = (slug) => {
  return slug && !slug.includes('/');
};

const createPage = async (browser, interceptRequests = true) => {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders(HEADERS);
  
  if (interceptRequests) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  // Disable JavaScript where possible to reduce load
  // await page.setJavaScriptEnabled(false); // Uncomment if the site works without JS

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    
    // Block trackers and analytics
    window.ga = function() {};
    window.gtag = function() {};
    window._gaq = { push: function() {} };
  });

  return page;
};

const fetchImageBuffer = async (url, referer = urlBase, retryCount = 0) => {
  // Increase timeout for large images (20 seconds)
  const { controller, timeout } = createTimeout(20000);
  
  try {
    const response = await fetch(url, {
      headers: {
        'Referer': referer,
        'User-Agent': HEADERS['User-Agent'],
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    // Clear timeout to prevent memory leak
    clearTimeout(timeout);
    
    // Retry logic - attempt up to 3 times with increasing delay
    if (retryCount < 3) {
      console.log(`Retrying fetch for ${url} (attempt ${retryCount + 1})...`);
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
      return fetchImageBuffer(url, referer, retryCount + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Enhanced database helpers with error handling and retries
const getComicFromDB = async (slug, retryCount = 0) => {
  try {
    const results = await sql`
      SELECT image_url FROM comics WHERE slug = ${slug}
    `;
    
    if (results?.length > 0 && results[0].image_url) {
      return results[0].image_url.split(',');
    }
    return null;
  } catch (error) {
    console.error('Database error:', error);
    
    // Retry logic for transient database errors
    if (retryCount < 2) {
      console.log(`Retrying database query for slug ${slug} (attempt ${retryCount + 1})...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
      return getComicFromDB(slug, retryCount + 1);
    }
    
    return null;
  }
};

const saveComicToDB = async (slug, fullUrl, imageUrls, retryCount = 0) => {
  if (!imageUrls || imageUrls.length === 0) {
    console.error('Attempted to save empty image URLs array');
    return false;
  }
  
  try {
    // Filter out any null values that might have crept in
    const validUrls = imageUrls.filter(url => url !== null && url !== undefined);
    
    if (validUrls.length === 0) {
      console.error('No valid image URLs to save');
      return false;
    }
    
    // Use a transaction if saving a lot of images
    await sql`
      INSERT INTO comics (slug, url, image_url, total_images, updated_at)
      VALUES (
        ${slug}, 
        ${fullUrl}, 
        ${validUrls.join(',')}, 
        ${validUrls.length}, 
        NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        image_url = ${validUrls.join(',')},
        total_images = ${validUrls.length},
        updated_at = NOW()
    `;
    
    console.log(`? Saved ${validUrls.length} images to database for slug: ${slug}`);
    return true;
  } catch (error) {
    console.error(`Failed to save to database (attempt ${retryCount + 1}):`, error);
    
    // Retry logic for transient database errors
    if (retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return saveComicToDB(slug, fullUrl, imageUrls, retryCount + 1);
    }
    
    return false;
  }
};

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    status: 'error',
    message: err.message || 'Internal server error'
  });
});

// Endpoints
app.get('/doujin', async (req, res) => {
  const pageNumber = req.query.page || 1;
  const targetUrl = `https://doujindesu.tv/doujin/page/${pageNumber}/`;

  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid URL format'
    });
  }

  const cacheKey = `doujin_page_${pageNumber}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({
      status: 'success',
      data: cached,
      source: 'cache'
    });
  }

  let browser;
  try {
    browser = await getBrowser();
    const page = await createPage(browser);
    
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', // Faster than networkidle2
      timeout: DEFAULT_TIMEOUT 
    });

    // Wait for the essential content to load
    await page.waitForSelector('.entries', { timeout: DEFAULT_TIMEOUT });

    // Extract minimal required data
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article.entry')).map(entry => {
        const anchor = entry.querySelector('a');
        const href = anchor?.getAttribute('href') || '';
        const slug = href.replace('/manga/', '').replace(/^\/|\/$/g, ''); // buang /manga/ dan slash depan/belakang
    
        return {
          title: entry.querySelector('h3.title span')?.innerText.trim(),
          thumbnail: entry.querySelector('img')?.src,
          type: entry.querySelector('.type')?.innerText.trim(),
          chapter: entry.querySelector('.artists a span')?.innerText.trim(),
          time: entry.querySelector('.dtch')?.innerText.trim(),
          link: slug || null
        };
      });
    });
    

    await page.close();
    releaseBrowser(browser);

    // Cache the results
    cache.set(cacheKey, results);
    
    res.set('Cache-Control', 'public, max-age=600');
    res.json({
      status: 'success',
      data: results,
      source: 'fresh'
    });
  } catch (error) {
    if (browser) releaseBrowser(browser);
    console.error('Error in /doujin:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

app.get('/get-comic', async (req, res) => {
  const slug = req.query.url;
  
  // Handle slug validation
  const cleanSlug = slug?.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanSlug) {
    return res.status(400).json({ error: 'Parameter url/slug wajib' });
  }

  try {
    // 1. Check database first for existing comic
    const dbImages = await getComicFromDB(cleanSlug);
    if (dbImages?.length > 0) {
      return res.json({ 
        success: true,
        images: dbImages,
        cached: true,
        source: 'database'
      });
    }

    // 2. Check memory cache
    const cacheKey = `comic-${cleanSlug}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // 3. Fetch from source
    let browser, page;
    try {
      browser = await getBrowser();
      // We need to load images here
      page = await createPage(browser, false);
      
      const fullUrl = `${urlBase}${cleanSlug}/`;
      
      await page.goto(fullUrl, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT
      });

      // Validate the page exists
      const pageTitle = await page.title();
      if (pageTitle.includes('404')) {
        await page.close();
        releaseBrowser(browser);
        return res.status(404).json({ error: 'Comic not found' });
      }

      await page.waitForSelector('#anu img', { timeout: DEFAULT_TIMEOUT });
      
      // Extract image URLs
      const imageUrls = await page.$$eval('#anu img', imgs => 
        imgs.map(img => img.dataset.src || img.src).filter(src => src && src.startsWith('http'))
      );      

      await page.close();
      releaseBrowser(browser);

      // 4. Upload to R2 Storage with improved error handling and retry
      const uploadedUrls = [];
      
      // Process uploads in batches of 3 with proper error handling
      for (let i = 0; i < imageUrls.length; i += 3) {
        const batch = imageUrls.slice(i, i + 3);
        const batchPromises = batch.map(async (url, batchIndex) => {
          const index = i + batchIndex;
          let retries = 0;
          const maxRetries = 2;
          
          while (retries <= maxRetries) {
            try {
              console.log(`Processing image ${index + 1}/${imageUrls.length}`);
              const buffer = await fetchImageBuffer(url);
              const ext = path.extname(url).split('?')[0] || '.jpg';
              const fileName = `${cleanSlug}_${index + 1}${ext}`;
              const uploadResult = await uploadToR2(buffer, `DOUJINSHI/${cleanSlug}/${fileName}`);
              console.log(`? Uploaded image ${index + 1}`);
              return uploadResult;
            } catch (uploadErr) {
              retries++;
              if (retries > maxRetries) {
                console.error(`? Failed to upload image ${index + 1} after ${maxRetries} retries:`, uploadErr.message);
                return null;
              }
              console.log(`?? Retry ${retries}/${maxRetries} for image ${index + 1}...`);
              // Wait before retrying (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
          }
        });
        
        try {
          const results = await Promise.all(batchPromises);
          uploadedUrls.push(...results.filter(url => url !== null));
        } catch (batchError) {
          console.error(`Batch error (images ${i+1}-${i+3}):`, batchError);
          // Continue with next batch even if this one failed
        }
      }

      // 5. Save to database if uploads successful
      if (uploadedUrls.length > 0) {
        await saveComicToDB(cleanSlug, fullUrl, uploadedUrls);
      }

      const response = {
        success: true,
        images: uploadedUrls,
        cached: false,
        source: 'freshly scraped',
        warning: uploadedUrls.length !== imageUrls.length ? 
          'Beberapa gambar gagal diupload' : undefined
      };
      
      cache.set(cacheKey, response);
      res.set('Cache-Control', 'public, max-age=600');
      return res.json(response);
    } catch (err) {
      if (page) await page.close();
      if (browser) releaseBrowser(browser);
      throw err;
    }
  } catch (err) {
    // Final check if there was a race condition
    const dbImages = await getComicFromDB(cleanSlug);
    if (dbImages?.length > 0) {
      return res.json({ 
        success: true,
        images: dbImages,
        cached: true,
        source: 'database (race condition recovery)'
      });      
    }
    
    console.error('Error in /get-comic:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  }
});

app.get('/proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('URL gambar diperlukan');

  // Increase proxy timeout to 15 seconds
  const { controller, timeout } = createTimeout(15000);
  
  // Try to get from cache first (memory or R2)
  const urlHash = require('crypto').createHash('md5').update(imageUrl).digest('hex');
  const cacheKey = `proxy-${urlHash}`;
  const cachedUrl = cache.get(cacheKey);
  
  if (cachedUrl) {
    return res.redirect(cachedUrl);
  }

  try {
    // Check if we already have this image in R2 storage
    const fileName = `proxy_${urlHash}.jpg`;
    const existing = await sql`
      SELECT cdn_url FROM thumbnails WHERE filename = ${fileName} AND source_url = ${imageUrl}
    `.catch(() => []);

    if (existing?.length > 0 && existing[0].cdn_url) {
      cache.set(cacheKey, existing[0].cdn_url);
      return res.redirect(existing[0].cdn_url);
    }

    // If not cached, fetch the image
    const response = await fetch(imageUrl, {
      headers: {
        'Referer': urlBase,
        'User-Agent': HEADERS['User-Agent']
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Gambar tidak ditemukan (Status: ${response.status})`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      throw new Error('URL tidak merujuk ke gambar yang valid');
    }

    // For frequently accessed images, store in R2
    const proxyCount = cache.get(`proxy-count-${urlHash}`) || 0;
    if (proxyCount > 3) {
      // This image has been requested multiple times, let's store it
      try {
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const uploadPath = `proxy/${fileName}`;
        const cdnUrl = await uploadToR2(imageBuffer, uploadPath);
        
        // Save to database
        await sql`
          INSERT INTO thumbnails (filename, source_url, cdn_url)
          VALUES (${fileName}, ${imageUrl}, ${cdnUrl})
          ON CONFLICT (filename) DO UPDATE SET
            cdn_url = EXCLUDED.cdn_url,
            updated_at = NOW()
        `;
        
        cache.set(cacheKey, cdnUrl);
        return res.redirect(cdnUrl);
      } catch (uploadError) {
        console.error('Failed to upload proxy image:', uploadError);
        // Continue with direct streaming if upload fails
      }
    } else {
      // Increment request counter for this URL
      cache.set(`proxy-count-${urlHash}`, proxyCount + 1);
    }

    // Stream the image directly if not stored
    const bodyStream = Readable.from(response.body);
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    bodyStream.pipe(res);
  } catch (err) {
    console.error(`Proxy Error [${imageUrl}]:`, err);
    const statusCode = err.message.includes('aborted') ? 504 : 500;
    res.status(statusCode).send(err.message);
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/search', async (req, res) => { 
  const query = req.query.q;
  const pageNumber = parseInt(req.query.page) || 1;
  if (!query) return res.status(400).json({ error: 'Query required' });

  const cacheKey = `search-${query}-${pageNumber}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  let browser, page;
  try {
    browser = await getBrowser();
    page = await createPage(browser);
    
    await page.goto(`https://doujindesu.tv/page/${pageNumber}/?s=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });

    // Optimized selector evaluation
    const results = await page.$$eval('.entries article', articles => 
      articles.map(article => ({
        title: article.querySelector('.metadata .title span')?.textContent.trim() || "No title",
        link: article.querySelector('a')?.href,
        thumbnail: article.querySelector('img')?.src,
        score: article.querySelector('.metadata .score')?.textContent.trim() || "N/A",
        status: article.querySelector('.metadata .status')?.textContent.trim() || "Unknown"
      }))
    );

    const response = {
      success: true,
      page: pageNumber,
      results,
      cached: false
    };

    cache.set(cacheKey, response);
    res.set('Cache-Control', 'public, max-age=600');
    res.json(response);

  } catch (err) {
    console.error('Error in /search:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  } finally {
    if (page) await page.close();
    if (browser) releaseBrowser(browser);
  }
});

app.get('/detail', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Parameter url wajib' });

  const cacheKey = `detail-${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  let browser, page;
  try {
    browser = await getBrowser();
    page = await createPage(browser);
    
    const fullUrl = url.startsWith('http') ? url : `https://doujindesu.tv/manga/${url}`;
    await page.goto(fullUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: DEFAULT_TIMEOUT 
    });

    await page.waitForSelector('.bxcl', { timeout: DEFAULT_TIMEOUT });

    // Streamline data extraction by running both operations in parallel
    const [chapters, detail] = await Promise.all([
      page.evaluate(() => {
        return Array.from(document.querySelectorAll('.bxcl ul li')).map(chapter => ({
          chapterTitle: chapter.querySelector('.epsright .eps a')?.innerText.trim(),
          chapterLink: chapter.querySelector('.epsright .eps a')?.getAttribute('href'),
          chapterName: chapter.querySelector('.epsleft .lchx a')?.innerText.trim(),
          chapterDate: chapter.querySelector('.epsleft .date')?.innerText.trim()
        }));
      }),
      page.evaluate(() => ({
        title: document.querySelector('h1.title')?.textContent,
        thumbnail: document.querySelector('.thumbnail img')?.src,
        rating: document.querySelector('.rating-prc')?.textContent,
        genres: Array.from(document.querySelectorAll('.tags a')).map(t => t.textContent)
      }))
    ]);

    const response = {
      success: true,
      detail: {
        ...detail,
        chapters
      },
      cached: false
    };

    cache.set(cacheKey, response);
    res.set('Cache-Control', 'public, max-age=600');
    res.json(response);

  } catch (err) {
    console.error('Error in /detail:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  } finally {
    if (page) await page.close();
    if (browser) releaseBrowser(browser);
  }
});

app.get('/get', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL is required' });
  }

  let browser;
  try {
    const parsedUrl = new URL(imageUrl);
    const fileName = path.basename(parsedUrl.pathname); // contoh: "45673.jpg"
    const uploadPath = `IMAGES/${fileName}`; // ? folder target di R2

    // Cek database
    const existing = await sql`
      SELECT cdn_url FROM thumbnails WHERE filename = ${fileName}
    `;

    if (existing.length > 0) {
      return res.json({ cdnUrl: existing[0].cdn_url });
    }

    // Bypass proteksi gambar
    browser = await getBrowser();
    const page = await createPage(browser);
    
    await page.goto(imageUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    const finalUrl = page.url();
    const imageResponse = await page.goto(finalUrl);
    const imageBuffer = await imageResponse.buffer();

    // ? Upload ke R2 di folder 'uploads/IMAGES/'
    const cdnUrl = await uploadToR2(imageBuffer, uploadPath);

    // Simpan ke database
    await sql`
      INSERT INTO thumbnails (filename, source_url, cdn_url)
      VALUES (${fileName}, ${imageUrl}, ${cdnUrl})
      ON CONFLICT (filename) DO UPDATE SET
        cdn_url = EXCLUDED.cdn_url,
        updated_at = NOW()
    `;
    
    return res.json({ cdnUrl });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: 'Gagal memproses gambar',
      details: error.message
    });
  } finally {
    if (browser) {
      await releaseBrowser(browser);
    }
  }
});


// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    browserPool: browserPool.length
  });
});

// Rate limiting middleware for better protection
const rateLimit = {};
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimit[ip]) {
    rateLimit[ip] = { count: 1, resetTime: now + 60000 }; // 1 minute window
  } else if (now > rateLimit[ip].resetTime) {
    rateLimit[ip] = { count: 1, resetTime: now + 60000 };
  } else {
    rateLimit[ip].count++;
    if (rateLimit[ip].count > 60) { // 60 requests per minute
      return res.status(429).json({ error: 'Too many requests' });
    }
  }
  
  next();
});

// Clean up rate limiting data periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimit).forEach(ip => {
    if (now > rateLimit[ip].resetTime) {
      delete rateLimit[ip];
    }
  });
}, 60000); // Every minute

// Initialize
(async () => {
  await initBrowserPool();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`?? Server ready at http://0.0.0.0:${PORT}`);
  });
})();

// Cleanup
process.on('exit', async () => {
  console.log('Shutting down browser pool...');
  await Promise.all(browserPool.map(b => b.close()));
});

// Handle unexpected errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});