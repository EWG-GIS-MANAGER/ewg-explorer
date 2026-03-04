exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { year, dataset, variables, formula } = body;

        if (!year || !Array.isArray(variables) || variables.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: year, variables[]' }) };
        }

        // Securely pull the API key from Netlify Environment Variables (optional)
        const API_KEY = process.env.CENSUS_API_KEY;

        // St. Louis EWG Region FIPS Codes
        const regions = [
            { state: '29', counties: ['071','099','113','183','189','510'] }, // Missouri
            { state: '17', counties: ['119','133','163'] }                    // Illinois
        ];

        const results = {};
        const censusSentinels = [-888888888, -666666666, -999999999, -222222222];

        // Decide endpoint
        const endpoint = dataset === 'subject' ? 'acs/acs5/subject' :
                         dataset === 'profile' ? 'acs/acs5/profile' :
                         'acs/acs5';

        // NOTE: Census API does NOT accept a comma-separated list of counties in the `in=` clause.
        // We request each county separately and merge.
        for (const region of regions) {
            for (const county of region.counties) {
                const url = new URL(`https://api.census.gov/data/${year}/${endpoint}`);
                url.searchParams.set('get', variables.join(','));
                url.searchParams.set('for', 'tract:*');
                url.searchParams.set('in', `state:${region.state} county:${county}`);
                if (API_KEY) url.searchParams.set('key', API_KEY);

                const response = await fetch(url.toString());
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new Error(`Census API ${response.status}: ${text || response.statusText}`);
                }

                const data = await response.json();
                const headers = data[0];

                for (let i = 1; i < data.length; i++) {
                    const row = data[i];
                    const rowData = {};

                    headers.forEach((header, index) => {
                        let val = parseFloat(row[index]);
                        if (isNaN(val) || censusSentinels.includes(val)) val = null;
                        rowData[header] = val;
                    });

                    const stateFips = row[headers.indexOf('state')].padStart(2, '0');
                    const countyFips = row[headers.indexOf('county')].padStart(3, '0');
                    const tractFips = row[headers.indexOf('tract')].padStart(6, '0');
                    const geoid = `GIS_${stateFips}${countyFips}${tractFips}`;

                    let finalValue = null;
                    if (formula) {
                        let expr = formula;
                        for (const v of variables) {
                            expr = expr.replaceAll(v, rowData[v] === null ? 'NaN' : rowData[v]);
                        }
                        try {
                            if (/^[\d\.\+\-\*\/\(\)\sNaN]+$/.test(expr)) {
                                finalValue = new Function('return ' + expr)();
                                if (isNaN(finalValue) || !isFinite(finalValue)) finalValue = null;
                            }
                        } catch { finalValue = null; }
                    } else {
                        finalValue = rowData[variables[0]];
                    }

                    results[geoid] = finalValue;
                }
            }
        }

        // Return the data to the browser
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(results)
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};