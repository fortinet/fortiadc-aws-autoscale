'use strict';
/*
Author: Fortinet
*
* AutoscaleHandler contains the core used to handle serving configuration files and
* manage the autoscale events from multiple cloud platforms.
*
* Use this class in various serverless cloud contexts. For each serverless cloud
* implementation extend this class and implement the handle() method. The handle() method
* should call other methods as needed based on the input events from that cloud's
* autoscale mechanism and api gateway requests from the fortiadc's callback-urls.
* (see reference AWS implementation {@link AwsAutoscaleHandler})
*
* Each cloud implementation should also implement a concrete version of the abstract
* {@link CloudPlatform} class which should be passed to super() in the constructor. The
* CloudPlatform interface should abstract each specific cloud's api. The reference
* implementation {@link AwsPlatform} handles access to the dynamodb for persistence and
* locking, interacting with the aws autoscaling api and determining the api endpoint url
* needed for the fortiadc config's callback-url parameter.
*/

// const
 //   AUTOSCALE_SECTION_EXPR =
  //  /(?:^|\n)\s*config?\s*system?\s*auto-scale[\s\n]*((?:.|\n)*)\bend\b/,
   // SET_SECRET_EXPR = /(set\s+(?:psksecret|password)\s+).*/g;

module.exports = class AutoscaleHandler {

    constructor(platform, baseConfig) {
        this.platform = platform;
        this._baseConfig = baseConfig;
    }

    throwNotImplementedException() {
        throw new Error('Not Implemented');
    }

    async handle() {
        await this.throwNotImplementedException();
    }

    async init() {
        await this.platform.init();
    }

    async getConfig(ip) {
        await this.throwNotImplementedException();
        return ip;
    }

    async getPrimaryConfig(callbackUrl) {
        return await this._baseConfig.replace(/\$\{CALLBACK_URL}/, callbackUrl);
    }

    // async getSecondaryConfig(primaryIp, callbackUrl, syncInterface, pskSecret, adminPort) {
    getSecondaryConfig(primaryIp, callbackUrl, syncInterface, adminPort, cfg_sync_port) {
        /*
        const
            autoScaleSectionMatch = AUTOSCALE_SECTION_EXPR.exec(this._baseConfig), //fix this match later
            autoScaleSection = autoScaleSectionMatch && autoScaleSectionMatch[1],
            matches = [
                /set\s+sync-interface\s+(.+)/.exec(autoScaleSection),
                /set\s+psksecret\s+(.+)/.exec(autoScaleSection),
                /set\s+port-https\s+(.+)/.exec(autoScaleSection)
            ];

        const [syncInterface, pskSecret, adminPort] = matches.map(m => m && m[1]),
        */
        const apiEndpoint = callbackUrl,
            config = `
                        config system auto-scale
                            set status enable
                            set sync-interface ${syncInterface ? syncInterface : 'port1'}
                            set role secondary
                            set primary-ip ${primaryIp}
                            set callback-url ${apiEndpoint}
                            set config-sync-port ${cfg_sync_port}
                        end
                        config system global
                            set port-https ${adminPort? adminPort:'8443'}
                            set port-http '8080'
                            set cloud-autoscale enable
                        end
                    `;
        let errorMessage;
        if (!apiEndpoint) {
            errorMessage = 'Api endpoint is missing';
        }
        if (!primaryIp) {
            errorMessage = 'Primary ip is missing';
        }
        
        
        if (!apiEndpoint || !primaryIp) {
         
       // if (!apiEndpoint || !primaryIp) {
             throw new Error(`Base config is invalid (${errorMessage}): ${
                    JSON.stringify({
                        syncInterface,
                        apiEndpoint,
                        primaryIp
                    })}`);
        }
        // await config.replace(SET_SECRET_EXPR, '$1 *');
        return config;
    }

    async holdPrimaryElection(ip) {
        await this.throwNotImplementedException();
        return ip;
    }

    async completePrimaryInstance(instanceId) {
        await this.throwNotImplementedException();
        return instanceId;
    }

    responseToHeartBeat(primaryIp) {
        let response = {};
        if (primaryIp) {
            response['primary-ip'] = primaryIp;
        }
        return JSON.stringify(response);
    }
};

