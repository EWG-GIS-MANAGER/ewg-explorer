const { app } = require('@azure/functions');

app.http('getCensusData', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            // The frontend will send these based on your acs5_variable_catalog.json
            const { year, dataset, variables, formula } = body;

            // Securely pull the API key from Azure App Settings
            const API_KEY = process.env.CENSUS_API_KEY; 
            
            // St. Louis EWG Region FIPS Codes
            const regions = [
                { state: '29', counties: '071,099,113,183,189,510' }, // Missouri
                { state: '17', counties: '119,133,163' }              // Illinois
            ];

            const results = {};
            const censusSentinels = [-888888888, -666666666, -999999999, -222222222];

            // Fetch data for both states
            for (const region of regions) {
                // Determine the correct dataset endpoint (acs5, profile, or subject)
                let endpoint = dataset === 'subject' ? 'acs/acs5/subject' : 
                               dataset === 'profile' ? 'acs/acs5/profile' : 'acs/acs5';

                const url = `https://api.census.gov/data/${year}/${endpoint}?get=${variables.join(',')}&for=tract:*&in=state:${region.state}&county:${region.counties}&key=${API_KEY}`;
                
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Census API Error: ${response.statusText}`);
                
                const data = await response.json();
                const headers = data[0];

                // Process rows
                for (let i = 1; i < data.length; i++) {
                    const row = data[i];
                    let rowData = {};
                    
                    // Map headers to row values and clean sentinels
                    headers.forEach((header, index) => {
                        let val = parseFloat(row[index]);
                        if (isNaN(val) || censusSentinels.includes(val)) {
                            val = null; // Clean sentinels
                        }
                        rowData[header] = val;
                    });

                    // Build the GEOID matching your Tracts_2020.geojson (e.g., GIS_29189222100)
                    const stateFips = row[headers.indexOf('state')].padStart(2, '0');
                    const countyFips = row[headers.indexOf('county')].padStart(3, '0');
                    const tractFips = row[headers.indexOf('tract')].padStart(6, '0');
                    const geoid = `GIS_${stateFips}${countyFips}${tractFips}`;

                    // Perform the math (Formula Evaluation)
                    let finalValue = null;
                    if (formula) {
                        let expr = formula;
                        // Replace Census variable IDs in the formula with actual numbers
                        for (const v of variables) {
                            expr = expr.replaceAll(v, rowData[v] === null ? 'NaN' : rowData[v]);
                        }
                        try {
                            // Safe math evaluation
                            if (/^[\d\.\+\-\*\/\(\)\sNaN]+$/.test(expr)) {
                                finalValue = new Function('return ' + expr)();
                                if (isNaN(finalValue) || !isFinite(finalValue)) finalValue = null;
                            }
                        } catch { finalValue = null; }
                    } else {
                        // Direct pull (Absolute values)
                        finalValue = rowData[variables[0]];
                    }

                    results[geoid] = finalValue;
                }
            }

            return { jsonBody: results };

        } catch (error) {
            context.error(error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});