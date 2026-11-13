Here are all the commands in order, for Windows PowerShell from the repo root (`D:\Programming\Hackathon\NASA-Hacakthon`). You've already done the setup and the POWER and SoilGrids pulls, so those steps are marked done.

**1. Get the latest code**
```powershell
git pull
```

**2. Install packages** (done)
```powershell
pip install requests earthaccess xarray netCDF4 h5netcdf
```

**3. Set your Earthdata login for this window.** Use your new password, since you changed the old one. You'll need to set this again in every new PowerShell window.
```powershell
$env:EARTHDATA_USER="your_username"; $env:EARTHDATA_PASS="your_new_password"
```

**4. Quick data pulls** (done)
```powershell
python pipeline/fetch_power.py
python pipeline/fetch_soilgrids.py
```

**5. Slow NASA jobs (AppEEARS)**
```powershell
python pipeline/appeears.py record modis_ndvi 7e9efa55-b809-43b5-8e33-879b9ddef527
python pipeline/appeears.py products SPL4
python pipeline/appeears.py products SMAP
```
Paste the product list here, and I'll fix the SMAP name. Then:
```powershell
python pipeline/appeears.py submit
```

**6. Optional rainfall cross-check.** If this fails, skip it. POWER is the fallback.
```powershell
python pipeline/fetch_imerg.py
```

**7. Wait until the jobs finish.** Repeat this until it says `done`:
```powershell
python pipeline/appeears.py status
```

**8. Download results and build the app data**
```powershell
python pipeline/appeears.py download
python pipeline/build_cache.py
```
Check the printed `gaps:` list for each location. It shows which sources are still missing.

**9. Run the tests**
```powershell
node tests/scoring.test.js
python tests/test_build_cache.py
```

**10. Open the app**
```powershell
python -m http.server 8000 --directory app
```
Then open http://localhost:8000. The red "PLACEHOLDER" banner should be gone.

**11. Save your work to GitHub**
```powershell
git add -A
git commit -m "Add real data"
git push
```

Steps 1–4 are done. You're at step 5, waiting for the SMAP product names and the MODIS job. Don't skip step 8: until `build_cache.py` runs, the app keeps showing synthetic data.