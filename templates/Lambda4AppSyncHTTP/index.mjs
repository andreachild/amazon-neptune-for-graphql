import axios from "axios";
import * as rax from 'retry-axios';
import { aws4Interceptor } from "aws4-axios";
import {resolveGraphDBQueryFromAppSyncEvent, refactorGremlinqueryOutput} from './output.resolver.graphql.js';

const LOGGING_ENABLED = true;

const {
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN,
    AWS_REGION
} = process.env;


if (process.env.NEPTUNE_IAM_AUTH_ENABLED === 'true') {
    const interceptor = aws4Interceptor({
        options: {
            region: AWS_REGION,
            service: "neptune-db",
        },
        credentials: {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
            sessionToken: AWS_SESSION_TOKEN
        }
    });

    axios.interceptors.request.use(interceptor);
}

rax.attach();

export const handler = async (event) => {
    let r = null;
    let resolver = { query:'', language: 'opencypher', fieldsAlias: {} };
    let result = null;

    // Create Neptune query from GraphQL query
    try {
        if (LOGGING_ENABLED) console.log("Event: ", event);
        resolver = resolveGraphDBQueryFromAppSyncEvent(event);
        if (LOGGING_ENABLED) console.log("Resolver: ", resolver);

        const myConfig = {
            raxConfig: {
              retry: 5, // number of retry when facing 4xx or 5xx
              noResponseRetries: 5, // number of retry when facing connection error
              onRetryAttempt: err => {
                const cfg = rax.getConfig(err);
                console.log(`Retry attempt #${cfg.currentRetryAttempt}`); // track current trial
              }
            },
            timeout: 2000
        };
        
        if (resolver.language == 'opencypher') {
            result = await axios.get(`https://${process.env.NEPTUNE_HOST}:${process.env.NEPTUNE_PORT}/opencypher?query=${encodeURIComponent(resolver.query)}`, myConfig);
        } else {
            result = await axios.get(`https://${process.env.NEPTUNE_HOST}:${process.env.NEPTUNE_PORT}?gremlin=${encodeURIComponent(resolver.query)}`, myConfig);
        }
        if (LOGGING_ENABLED) console.log("Result: ", JSON.stringify(result.data, null, 2));
    } catch (err) {
        if (LOGGING_ENABLED) console.error(err);
        return {
            "error": [{ "message": err}]
        };
    }
    
    if (LOGGING_ENABLED) console.log("Got data.");

    // Based on Neptune query type
    if (resolver.language == 'gremlin') {
        const input = result.data["result"]["data"];
        const refac = refactorGremlinqueryOutput(input, resolver.fieldsAlias);
        console.log("Refac: ", refac);
        r = JSON.parse(refac);        
    } 

    if (resolver.language == 'opencypher') {
        let data = result.data;
        if (data.results.length == 0) {
            return null;
        }        
        r = data.results[0][Object.keys(data.results[0])[0]];
    }

    return r;
};