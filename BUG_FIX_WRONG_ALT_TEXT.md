# Bug Fix: Wrong Alt Text Generation

## Problem

The backend is generating incorrect alt text descriptions. For example:
- **Expected:** "Solid coral-colored background with white text reading 'test-image-1.jpg'"
- **Actual:** "Web analytics dashboard displaying user engagement metrics"

This suggests the wrong image is being processed or cached results are being returned.

## Root Causes Identified

### 1. **Cache Key Generated Before Normalization** ⚠️ CRITICAL
- **Issue:** Cache key was generated from raw base64 data BEFORE validation/normalization
- **Problem:** If frontend sends base64 with data URL prefix (`data:image/jpeg;base64,...`), the cache key would be different from normalized base64
- **Impact:** Could cause cache misses or worse - cache hits for wrong data if hash collisions occur
- **Fix:** Now generates cache key from NORMALIZED base64 (after stripping data URL prefix)

### 2. **Regenerate Flag Not Implemented** ⚠️ HIGH
- **Issue:** `regenerate: true` flag in request body was completely ignored
- **Problem:** Users couldn't force regeneration even when they knew cache was wrong
- **Impact:** Stale/wrong cached results couldn't be bypassed via regenerate flag
- **Fix:** Now explicitly handles `regenerate` flag in body or query params

### 3. **Insufficient Logging for Debugging** ⚠️ MEDIUM
- **Issue:** Limited logging made it hard to debug what image data was actually being processed
- **Problem:** Couldn't verify if wrong base64 was sent, wrong URL was used, or cache returned wrong data
- **Impact:** Difficult to diagnose the root cause
- **Fix:** Added comprehensive logging at every step

### 4. **No Warning When Both Base64 and URL Provided** ⚠️ LOW
- **Issue:** When both base64 and URL are present, base64 takes priority silently
- **Problem:** If base64 is wrong but URL is correct, no warning is logged
- **Impact:** Could lead to confusion about which image source is being used
- **Fix:** Added warning log when both are provided

## Fixes Applied

### 1. Fixed Cache Key Generation
```javascript
// BEFORE: Cache key from raw base64 (before normalization)
const base64Data = image.base64 || image.image_base64 || '';
const cacheKey = base64Data ? hashPayload(base64Data) : null;
// ... then validate later

// AFTER: Validate FIRST, then generate cache key from normalized base64
const { errors, warnings, normalized } = validateImagePayload(image);
const normalizedBase64 = normalized.base64 || '';
const cacheKey = normalizedBase64 ? hashPayload(normalizedBase64) : null;
```

**Benefits:**
- Cache consistency regardless of how frontend sends base64 (with/without data URL prefix)
- Prevents cache key mismatches
- Ensures same image always generates same cache key

### 2. Implemented Regenerate Flag
```javascript
// Support regenerate flag in body or query, plus cache bypass headers
const regenerate = req.body.regenerate === true || req.query.regenerate === 'true' || req.query.regenerate === '1';
const bypassCache = regenerate || req.header('X-Bypass-Cache') === 'true' || req.query.no_cache === '1';
```

**Benefits:**
- Users can now force regeneration via `regenerate: true` in request body
- Also supports query param: `?regenerate=true` or `?regenerate=1`
- Maintains backward compatibility with existing bypass methods

### 3. Enhanced Logging
Added detailed logging at multiple points:

**Request Logging:**
- Raw vs normalized base64 preview
- Image source (base64 vs URL)
- Cache key and bypass status
- Dimensions and filename

**Image Processing Logging:**
- What image data OpenAI receives
- Data URL construction details
- Warning when both base64 and URL provided

**Cache Logging:**
- Cache hits with cached alt text preview
- Cache bypass reasons
- Model used for cached results

**AI Response Logging:**
- Full raw AI response (JSON)
- Generated alt text
- Image source used

### 4. Added Warnings
```javascript
// CRITICAL: Verify we're using the correct image source
if (image.base64 && image.url) {
  logger.warn('[OpenAI] WARNING: Both base64 and URL provided - base64 will be used, URL ignored', {
    base64Length: image.base64.length,
    url: image.url
  });
}
```

## How to Debug Wrong Alt Text

### Step 1: Check Logs
Look for these log entries in order:

1. **`[altText] Request received`**
   - Verify `imageSource` is correct (should be 'base64' if sending base64)
   - Check `normalizedBase64Preview` matches your test image
   - Verify `cacheKey` is generated

2. **`[altText] Cache hit`** (if present)
   - Check `cachedAltText` - this might be the wrong description
   - If cache hit, the wrong image might be cached
   - **Solution:** Use `regenerate: true` to bypass cache

3. **`[OpenAI] Image processing details`**
   - Verify `base64Preview` matches your test image
   - Check `dataUrlStartsWith` should be `data:image/...`
   - Verify `dimensions` match your image

4. **`[OpenAI] Raw AI response received`**
   - Check `choiceContent` - this is what OpenAI actually returned
   - Compare with expected description
   - If wrong, OpenAI is processing wrong image

### Step 2: Common Issues

**Issue: Cache returning wrong data**
- **Symptom:** Logs show cache hit with wrong alt text
- **Solution:** 
  - Send `regenerate: true` in request body
  - Or use header: `X-Bypass-Cache: true`
  - Or clear Redis cache

**Issue: Wrong base64 being sent**
- **Symptom:** `normalizedBase64Preview` doesn't match expected image
- **Solution:** Check frontend code - verify correct image is being encoded

**Issue: URL being used instead of base64**
- **Symptom:** `imageSource: 'url'` in logs, but you sent base64
- **Solution:** Check if base64 validation failed and fell back to URL

**Issue: Both base64 and URL provided, wrong one used**
- **Symptom:** Warning log about both being provided
- **Solution:** Remove URL from request if sending base64 (or vice versa)

### Step 3: Test with Regenerate Flag

```json
{
  "image": {
    "image_base64": "your-base64-here",
    "width": 512,
    "height": 512,
    "mime_type": "image/jpeg",
    "filename": "test-image-1.jpg"
  },
  "regenerate": true
}
```

This will:
- Bypass cache completely
- Force new OpenAI API call
- Generate fresh alt text
- Log everything for debugging

## Testing Checklist

- [ ] Send request with ONLY `image_base64` (no URL)
- [ ] Check logs show `imageSource: 'base64'`
- [ ] Verify `normalizedBase64Preview` matches your image
- [ ] Check cache status (hit/miss/bypassed)
- [ ] Compare `cachedAltText` vs `choiceContent` if cache hit
- [ ] Test with `regenerate: true` to bypass cache
- [ ] Verify correct alt text is generated after cache bypass

## Files Changed

1. **`fresh-stack/routes/altText.js`**
   - Moved validation before cache key generation
   - Added regenerate flag support
   - Enhanced logging throughout

2. **`fresh-stack/lib/openai.js`**
   - Added warning when both base64 and URL provided
   - Enhanced image processing logging
   - Added image source tracking in response logs

## Next Steps

1. **Deploy these fixes** to production
2. **Test with coral test image** using `regenerate: true`
3. **Check logs** to see what image data is actually being processed
4. **Clear Redis cache** if stale data is suspected
5. **Verify frontend** is sending correct base64 data

## Expected Behavior After Fix

- Cache keys are consistent (same image = same key)
- Regenerate flag works to bypass cache
- Comprehensive logs show exactly what's happening
- Warnings alert when both base64 and URL provided
- Easier to diagnose wrong alt text issues

