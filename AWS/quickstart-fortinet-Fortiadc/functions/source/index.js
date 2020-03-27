'use strict';

/*
Fortiadc Autoscale AWS Lambda Function (1.0.0-alpha)
Author: Fortinet
*/

const fadcAutoscaleAws = require('fortiadc-autoscale-aws');
/**
 * AWS Lambda Entry.
 * @param {Object} event The event been passed to
 * @param {Object} context The Lambda function runtime context
 * @param {Function} callback a callback function been triggered by AWS Lambda mechanism
 */
exports.AutoscaleHandler = async (event, context, callback) => {
    console.log(`Incoming event: ${JSON.stringify(event)}`);
    fadcAutoscaleAws.initModule();
    await fadcAutoscaleAws.handler(event, context, callback);
};
