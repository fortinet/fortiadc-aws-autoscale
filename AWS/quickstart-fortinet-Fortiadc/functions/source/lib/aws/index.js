'use strict';
/*
FortiADC Autoscale AWS Module (1.0.0-alpha)
Author: Fortinet
*/
exports = module.exports;
const path = require('path');
const AWS = require('aws-sdk');
const AutoScaleCore = require('fortiadc-autoscale-core');

// lock the API versions
AWS.config.apiVersions = {
    autoscaling: '2011-01-01',
    ec2: '2016-11-15',
    lambda: '2015-03-31',
    dynamodb: '2012-08-10',
    apiGateway: '2015-07-09',
    s3: '2006-03-01'
};

const
    EXPIRE_LIFECYCLE_ENTRY = (process.env.EXPIRE_LIFECYCLE_ENTRY || 60 * 60) * 1000,
    autoScaling = new AWS.AutoScaling(),
    dynamodb = new AWS.DynamoDB(),
    docClient = new AWS.DynamoDB.DocumentClient(),
    ec2 = new AWS.EC2(),
    apiGateway = new AWS.APIGateway(),
    s3 = new AWS.S3(),
    unique_id = process.env.UNIQUE_ID.replace(/.*\//, ''),
    custom_id = process.env.CUSTOM_ID.replace(/.*\//, ''),
    // SCRIPT_TIMEOUT = 300,
    DB = {
        LIFECYCLEITEM: {
            AttributeDefinitions: [
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'actionName',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'instanceId',
                    KeyType: 'HASH'
                },
                {
                    AttributeName: 'actionName',
                    KeyType: 'RANGE'
                }
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1
            },
            TableName: `${custom_id}-FortiadcLifecycleItem-${unique_id}`
        },
        AUTOSCALE: {
            AttributeDefinitions: [
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'instanceId',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1
            },
            TableName: `${custom_id}-FortiadcAutoscale-${unique_id}`
        },
        ELECTION: {
            AttributeDefinitions: [
                {
                    AttributeName: 'asgName',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'ip',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'vpcId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'subnetId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'voteState',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'asgName',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
            TableName: `${custom_id}-FortiadcMasterElection-${unique_id}`
        },
        CONFIGSET: {
            AttributeDefinitions: [
                {
                    AttributeName: 'configName',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'configContent',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'configName',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
            TableName: `${custom_id}-FortiadcConfigSet-${unique_id}`
        }

    },
    moduleId = AutoScaleCore.uuidGenerator(JSON.stringify(`${__filename}${Date.now()}`));

let logger = new AutoScaleCore.DefaultLogger();
/**
 * Implements the CloudPlatform abstraction for the AWS api.
 */
class AwsPlatform extends AutoScaleCore.CloudPlatform {
    async init() {
        try {
            await Promise.all([
                this.tableExists(DB.AUTOSCALE),
                this.tableExists(DB.ELECTION),
                this.tableExists(DB.LIFECYCLEITEM)
            ]);
            return true;
        } catch (ex) {
            this._initErrorTableNotExists = true;
            logger.warn('some tables are missing, script enters instance termination process');
            return false;
        }
    }

    async createTable(schema) {
        try {
            await dynamodb.describeTable({TableName: schema.TableName}).promise();
            console.log('found table', schema.TableName);
        } catch (ex) {
            console.log('creating table ', schema.TableName);
            await dynamodb.createTable(schema).promise();
        }
        await dynamodb.waitFor('tableExists', {TableName: schema.TableName}).promise();
    }

    async tableExists(schema) {
        try {
            await dynamodb.describeTable({ TableName: schema.TableName }).promise();
            logger.log('found table', schema.TableName);
            return true;
        } catch (ex) {
            throw new Error(`table (${schema.TableName}) not exists!`);
        }
    }

    async createTables() {
        try {
            await Promise.all([
                this.createTable(DB.AUTOSCALE),
                this.createTable(DB.ELECTION),
                this.createTable(DB.LIFECYCLEITEM)
            ]);
            return true;
        } catch (ex) {
            logger.warn('some tables are unable to create. Please read logs for more information.');
            return false;
        }
    }
    async terminateInstanceInAutoScalingGroup(instance) {
        logger.info('calling terminateInstanceInAutoScalingGroup');
        let params = {
            InstanceId: instance.instanceId,
            ShouldDecrementDesiredCapacity: false
        };
        try {
            let result = await autoScaling.terminateInstanceInAutoScalingGroup(params).promise();
            logger.info('called terminateInstanceInAutoScalingGroup. done.', result);
            return true;
        } catch (error) {
            logger.warn('called terminateInstanceInAutoScalingGroup. failed.', error);
            return false;
        }
    }
    async removeInstance(instance) {
        return await this.terminateInstanceInAutoScalingGroup(instance);
    }
    // unfortunately we can't link up the api gateway id during CFT stack creation as it
    // would create a cycle. Grab it by looking up the rest api name passed as a parameter
    async getCallbackEndpointUrl() {
        let position,
            page;
        const
            gwName = process.env.API_GATEWAY_NAME,
            region = process.env.AWS_REGION,
            stage = process.env.API_GATEWAY_STAGE_NAME,
            resource = process.env.API_GATEWAY_RESOURCE_NAME;
        do {

            this._step = 'handler:getApiGatewayUrl:getRestApis';
            page = await apiGateway.getRestApis({
                position
            }).promise();
            position = page.position;
            const
                gw = page.items.find(i => i.name === gwName);
            if (gw) {
                return `https://${gw.id}.execute-api.${region}.amazonaws.com/` +
                    `${stage}/${resource}`;
            }
        } while (page.items.length);
        throw new Error(`Api Gateway not found looking for ${gwName}`);
    }

    // Override
    async getLifecycleItems(instanceId) {
        logger.info(`calling getLifecycleItems, instanceId: ${instanceId}`);
        const query = {
                TableName: DB.LIFECYCLEITEM.TableName,
                KeyConditionExpression: '#InstanceId = :InstanceId',
                ExpressionAttributeNames: {
                    '#InstanceId': 'instanceId'
                },
                ExpressionAttributeValues: {
                    ':InstanceId': instanceId
                }
            },
            response = await docClient.query(query).promise(),
            items = response.Items;
        if (!items || !Array.isArray(items)) {
            logger.info('called getLifecycleItems. No pending lifecycle action.');
            return [];
        }
        logger.info('called getLifecycleItems. ' +
            `[${items.length}] pending lifecycle action. response: ${JSON.stringify(items)}`);
        return items.map(item => AutoScaleCore.LifecycleItem.fromDb(item));
    }
    /**
     * @param {LifecycleItem} item Item containing the data to store.
     */
    async updateLifecycleItem(item) {
        const params = {
            TableName: DB.LIFECYCLEITEM.TableName,
            Item: item.toDb()
        };
        return await docClient.put(params).promise();
    }

    // override
    async cleanUpDbLifeCycleActions(items = [], force = false) {
        try {
            const tableName = DB.LIFECYCLEITEM.TableName;
            if (!items || Array.isArray(items) && items.length === 0) {

                const
                    response = await docClient.scan({
                        TableName: tableName,
                        Limit: 5
                    })
                    .promise();
                items = response.Items;
                if (Array.isArray(items) && items.length) {
                    return await this.cleanUpDbLifeCycleActions(items);
                }
            } else {
                logger.info('calling cleanUpDbLifeCycleActions');
                let itemToRemove = [],
                    awaitAll = [];
                let remove = async item => {
                    logger.info('cleaning up old entry: ' +
                        `${item.instanceId} (${(Date.now() - item.timestamp) / 1000}s) ago`);
                    await docClient.delete({
                        TableName: tableName,
                        Key: {
                            instanceId: item.instanceId,
                            actionName: item.actionName
                        }
                    }).promise();
                };
                items.forEach(item => {
                    if (force || (Date.now() - item.timestamp > EXPIRE_LIFECYCLE_ENTRY)) {
                        awaitAll.push(remove(item));
                        itemToRemove.push(item);
                    }
                });
                await Promise.all(awaitAll);
                logger.info(`cleaned up items: ${JSON.stringify(itemToRemove)}`);
                return true;
            }
        } catch (ex) {
            console.error('Error while cleaning up (ignored):', ex);
        }
        return false;
    }

    async completeLifecycleAction(lifecycleItem, success) {
        logger.info('calling completeLifecycleAction');
        try {
            await this.updateLifecycleItem(lifecycleItem);
            var params = {
                AutoScalingGroupName: lifecycleItem.detail.AutoScalingGroupName,
                LifecycleActionResult: success ? 'CONTINUE' : 'ABANDON',
                LifecycleActionToken: lifecycleItem.detail.LifecycleActionToken,
                LifecycleHookName: lifecycleItem.detail.LifecycleHookName
                // InstanceId: event.instanceId
            };
            if (!process.env.DEBUG_MODE) {
                await autoScaling.completeLifecycleAction(params).promise();
            }
            logger.info(
            `[${params.LifecycleActionResult}] applied to hook[${params.LifecycleHookName}] with
            token[${params.LifecycleActionToken}] in auto-scaling group
            [${params.AutoScalingGroupName}]`);
            return true;
        } catch (error) {
            logger.error(`called completeLifecycleAction. error:${error.message}`);
            return false;
        }
    }

    /**
     * Get the ip address which won the master election
     * @returns {Object} Master record of the fortiadc which should be the auto-sync master
     */
    async getElectedMaster() {
        const
            params = {
                TableName: DB.ELECTION.TableName,
                FilterExpression: '#PrimaryKeyName = :primaryKeyValue',
                ExpressionAttributeNames: {
                    '#PrimaryKeyName': 'asgName'
                },
                ExpressionAttributeValues: {
                    ':primaryKeyValue': process.env.AUTO_SCALING_GROUP_NAME
                }
            },
            response = await docClient.scan(params).promise(),
            items = response.Items;
        if (!items || items.length === 0) {
            logger.info('No elected master was found in the db!');
            return null;
        }
        logger.info(`Elected master found: ${JSON.stringify(items[0])}`, JSON.stringify(items));
        return items[0];
    }
    async getMasterRecord() {
        return await this.getElectedMaster();
    }
    async removeMasterRecord() {
        // only purge the master with a done votestate to avoid a
        // race condition
        const params = {
            TableName: DB.ELECTION.TableName,
            Key: {
                // asgName: process.env.AUTO_SCALING_GROUP_NAME,
                // votestate: "done"
                asgName: process.env.AUTO_SCALING_GROUP_NAME
            } 
        };
        return await docClient.delete(params).promise();
    }
    async finalizeMasterElection() {
        try {
            logger.info('calling finalizeMasterElection');
            let electedMaster = await this.getElectedMaster();
            electedMaster.voteState = 'done';
            const params = {
                TableName: DB.ELECTION.TableName,
                Item: electedMaster
            };
            let result = await docClient.put(params).promise();
            logger.info(`called finalizeMasterElection, result: ${JSON.stringify(result)}`);
            return result;
        } catch (ex) {
            logger.warn('called finalizeMasterElection, error:', ex.stack);
            return false;
        }
    }
    async addConfig(heartBeatLossCount = 5, heartDelayAllowance = 60) {
        logger.info('calling addConfig');
        
        var searchparams = {
            Key: {
                configName: 'heartBeatAllowLossCount'
            },
            TableName: DB.CONFIGSET.TableName
        }
        var data = await docClient.get(searchparams).promise();
        if (!data.Item) {
            console.log('no heartBeatLossCount');
            var params = {
                Item: {
                    configName: 'heartBeatAllowLossCount',
                    value: heartBeatLossCount
                },
                TableName: DB.CONFIGSET.TableName
            };
            await docClient.put(params).promise();
        } else {
            heartBeatLossCount = data.Item.value;
        }
        searchparams = {
            Key: {
                configName: 'heartDelayAllowance'
            },
            TableName: DB.CONFIGSET.TableName
        }
        data = await docClient.get(searchparams).promise();
        if (!data.Item) {
            console.log('no heartDelayAllowance');
            params = {
            Item: {
                configName: 'heartDelayAllowance',
                value: heartDelayAllowance
            },
            TableName: DB.CONFIGSET.TableName
         };
         await docClient.put(params).promise();
                
        }else {
            heartDelayAllowance = data.Item.value;
        }
        
        return [heartBeatLossCount, heartDelayAllowance]
    }

    /**
     * get the health check info about an instance been monitored.
     * @param {Object} instance instance object which a vmId property is required.
     * @param {Number} heartBeatInterval integer value, unit is second.
     */
    async getInstanceHealthCheck(instance, heartBeatInterval) {
        // TODO: not fully implemented in V3
        if (!(instance && instance.instanceId)) {
            logger.error('getInstanceHealthCheck > error: no instanceId property found' +
            ` on instance: ${JSON.stringify(instance)}`);
            return Promise.reject(`invalid instance: ${JSON.stringify(instance)}`);
        }
        var params = {
            Key: {
                instanceId: instance.instanceId
            },
            TableName: DB.AUTOSCALE.TableName
        };
        try {
            let scriptExecutionStartTime,
                healthy,
                heartBeatLossCount,
                heartBeatAllowLossCount = 5,
                heartBeatDelays,
                heartBeatDelayAllowance = 60*1000,
                // parseInt(this._settings['heartbeat-delay-allowance']) * 1000,

                inevitableFailToSyncTime,
                interval,
                healthCheckRecord,
                data = await docClient.get(params).promise();
            if (!data.Item) {
                logger.info('called getInstanceHealthCheck: no record found');
                return null;
            }
            let hb_info = await this.addConfig(heartBeatAllowLossCount, (heartBeatDelayAllowance/1000));
            if (hb_info.length === 2) {
                heartBeatAllowLossCount = hb_info[0];
                heartBeatDelayAllowance = hb_info[1] * 1000;
                logger.info('heartBeatAllowLossCount is '+`${heartBeatAllowLossCount}` + ' heartBeatDelayAllowance is ' + `${heartBeatDelayAllowance}`);
            }

            healthCheckRecord = data.Item;
            scriptExecutionStartTime = process.env.SCRIPT_EXECUTION_TIME_CHECKPOINT;
            interval = heartBeatInterval && !isNaN(heartBeatInterval) ?
                heartBeatInterval : healthCheckRecord.heartBeatInterval;
            heartBeatDelays = scriptExecutionStartTime - healthCheckRecord.nextHeartBeatTime;
            // The the inevitable-fail-to-sync time is defined as:
            // the maximum amount of time for an instance to be able to sync without being
            // deemed unhealth. For example:
            // the instance has x (x < hb loss count allowance) loss count recorded.
            // the hb loss count allowance is X.
            // the hb interval is set to i second.
            // its hb sync time delay allowance is I ms.
            // its current hb sync time is t.
            // its expected next hb sync time is T.
            // if t > T + (X - x - 1) * (i * 1000 + I), t has passed the
            // inevitable-fail-to-sync time. This means the instance can never catch up
            // with a heartbeat sync that makes it possile to deem health again.
            inevitableFailToSyncTime = healthCheckRecord.nextHeartBeatTime +
                // add setting later. define hb loss count to 3 for test
                // (parseInt(this._settings['heartbeat-loss-count']) -
                    (heartBeatAllowLossCount -
                    healthCheckRecord.heartBeatLossCount - 1) *
                (interval * 1000 + heartBeatDelayAllowance);
            // based on the test results, network delay brought more significant side effects
            // to the heart beat monitoring checking than we thought. we have to expand the
            // checking time to reasonably offset the delay.
            // heartBeatDelayAllowance is used for this purpose
            if (heartBeatDelays < heartBeatDelayAllowance) {
                // reset hb loss count if instance sends hb within its interval
                healthy = true;
                heartBeatLossCount = 0;
            } else {
                // if the current sync heartbeat is late, the instance is still considered
                // healthy unless the the inevitable-fail-to-sync time has passed.
                healthy = scriptExecutionStartTime <= inevitableFailToSyncTime;
                heartBeatLossCount = healthCheckRecord.heartBeatLossCount + 1;
                logger.info(`hb sync is late${heartBeatLossCount > 1 ? ' again' : ''}.\n` +
                    `hb loss count becomes: ${heartBeatLossCount},\n` +
                    `hb sync delay allowance: ${heartBeatDelayAllowance} ms\n` +
                    'expected hb arrived time: ' +
                    `${healthCheckRecord.nextHeartBeatTime} ms in unix timestamp\n` +
                    'current hb sync check time: ' +
                    `${scriptExecutionStartTime} ms in unix timestamp\n` +
                    `this hb sync delay is: ${heartBeatDelays} ms`);
                // log the math why this instance is deemed unhealthy
                if (!healthy) {
                    logger.info('Instance '+ `${instance.instanceId}` + 'is deemed unhealthy. reasons:\n' +
                        `previous hb loss count: ${healthCheckRecord.heartBeatLossCount},\n` +
                        `hb sync delay allowance: ${heartBeatDelayAllowance} ms\n` +
                        'expected hb arrived time: ' +
                        `${healthCheckRecord.nextHeartBeatTime} ms in unix timestamp\n` +
                        'current hb sync check time: ' +
                        `${scriptExecutionStartTime} ms in unix timestamp\n` +
                        `this hb sync delays: ${heartBeatDelays} ms\n` +
                        'the inevitable-fail-to-sync time: ' +
                        `${inevitableFailToSyncTime} ms in unix timestamp has passed.`);
                }
            }
            logger.info('called getInstanceHealthCheck. (timestamp: ' +
                `${scriptExecutionStartTime},  interval:${heartBeatInterval})` +
                'healthcheck record:',
                JSON.stringify(healthCheckRecord));
            return {
                instanceId: instance.instanceId,
                ip: healthCheckRecord.ip || '',
                healthy: healthy,
                heartBeatLossCount: heartBeatLossCount,
                heartBeatInterval: interval,
                nextHeartBeatTime: Date.now() + interval * 1000,
                // masterIp: healthCheckRecord.masterIp,
                // syncState: healthCheckRecord.syncState,
                // inSync: healthCheckRecord.syncState === 'in-sync',
                inevitableFailToSyncTime: inevitableFailToSyncTime,
                healthCheckTime: scriptExecutionStartTime
            };

        } catch (error) {
            logger.info('called getInstanceHealthCheck with error. ' +
            `error: ${JSON.stringify(error)}`);
            return null;
        }
    }
    async updateInstanceHealthCheck(healthCheckObject, heartBeatInterval, masterIp, checkPointTime,
        forceOutOfSync = false) {
        if (!(healthCheckObject && healthCheckObject.instanceId)) {
            logger.error('updateInstanceHealthCheck > error: no instanceId property found' +
                ` on healthCheckObject: ${JSON.stringify(healthCheckObject)}`);
            return Promise.reject('invalid healthCheckObject: ' +
                `${JSON.stringify(healthCheckObject)}`);
        }
        try {
            let params = {
                Key: {
                    instanceId: healthCheckObject.instanceId
                },
                TableName: DB.AUTOSCALE.TableName,
                UpdateExpression: 'set heartBeatLossCount = :HeartBeatLossCount, ' +
                    'nextHeartBeatTime = :NextHeartBeatTime, ' +
                    'heartBeatInterval = :HeartBeatInterval',
                ExpressionAttributeValues: {
                    ':HeartBeatLossCount': healthCheckObject.heartBeatLossCount,
                    ':HeartBeatInterval': heartBeatInterval,
                    ':NextHeartBeatTime': checkPointTime + heartBeatInterval * 1000
                    // ':MasterIp': masterIp ? masterIp : 'null',
                    // ':SyncState': healthCheckObject.healthy && !forceOutOfSync ?
                    //    'in-sync' : 'out-of-sync'
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            };
            
            if (!forceOutOfSync) {
                // params.ConditionExpression += ' AND syncState = :SyncState';
            }
            
            let result = await docClient.update(params).promise();
            logger.info('called updateInstanceHealthCheck');
            return !!result;
        } catch (error) {
            logger.info('called updateInstanceHealthCheck with error. ' +
                `error: ${JSON.stringify(error)}`);
            return Promise.reject(error);
        }
    }

    async deleteInstanceHealthCheck(instanceId) {
        try {
            let params = {
                TableName: DB.AUTOSCALE.TableName,
                Key: {
                    instanceId: instanceId
                }
            };
            let result = await docClient.delete(params).promise();
            logger.info('called deleteInstanceHealthCheck result:' +  `${JSON.stringify(result)}`);
            return !!result;
        } catch (error) {
            logger.warn('called deleteInstanceHealthCheck. error:', error);
            return false;
        }
    }

    /**
     * Get information about an instance by the given parameters.
     * @param {Object} parameters parameters accepts: instanceId, privateIp, publicIp
     */
    async describeInstance(parameters) {
        logger.info('calling describeInstance');
        let params = {Filters: []};
        if (parameters.instanceId) {
            params.Filters.push({
                Name: 'instance-id',
                Values: [parameters.instanceId]
            });
        }
        if (parameters.publicIp) {
            params.Filters.push({
                Name: 'ip-address',
                Values: [parameters.publicIp]
            });
        }
        if (parameters.privateIp) {
            params.Filters.push({

                Name: 'private-ip-address',
                Values: [parameters.privateIp]
            });
        }
        const result = await ec2.describeInstances(params).promise();
        logger.info(`called describeInstance, result: ${JSON.stringify(result)}`);
        return result.Reservations[0] && result.Reservations[0].Instances[0];
    }

    async findInstanceIdByIp(localIp) {
        if (!localIp) {
            throw new Error('Cannot find instance by Ip because ip is invalid: ', localIp);
        }
        const params = {
            Filters: [{
                Name: 'private-ip-address',
                Values: [localIp]
            }]
        };
        const result = await ec2.describeInstances(params).promise();
        logger.log(localIp, 'DescribeInstances', result);
        const instance = result.Reservations[0] && result.Reservations[0].Instances[0];
        return instance && instance.InstanceId;
    }

    async protectInstanceFromScaleIn(asgName, item, protect = true) {
        const
            MAX_TRIES = 10,
            // Delay the attempt to setInstanceProtection because it takes around a second
            // for autoscale to switch the instance to `InService` status.
            PROTECT_DELAY = 2000;
        let count = 0;
        while (true) { // eslint-disable-line no-constant-condition
            try {
                await runAfter(PROTECT_DELAY, () => autoScaling.setInstanceProtection({
                    AutoScalingGroupName: asgName,
                    InstanceIds: [item.instanceId],
                    ProtectedFromScaleIn: protect !== false
                }).promise());
                return true;
            } catch (ex) {
                if (/\bnot in InService\b/.test(ex.message) && count < MAX_TRIES) {
                    ++count;
                    logger.log(`${ex.message} while protecting ${item.instanceId}:
                        (trying again ${count}/${MAX_TRIES})`);
                } else {
                    throw ex;
                }
            }
        }

        function runAfter(interval, callback) {
            const precision = Math.max(0, 3 - Math.log10(interval / 100));
            logger.log(`Delaying for ${(interval / 1000).toFixed(precision)}s > `,
                callback.toString()
                .replace(/.*(?:function|=>)\s*(.*?)(?:[(\n]|$)(?:\n|.)*/, '$1'));
            return new Promise(resolve => setTimeout(() => resolve(callback()), interval));
        }
    }
}

class AwsAutoscaleHandler extends AutoScaleCore.AutoscaleHandler {
    constructor(platform = new AwsPlatform(), baseConfig = '') {
        super(platform, baseConfig);
        this._step = '';
        this._selfInstance = null;
        this._init = false;
        this._selfHealthCheck = null;
        this._masterRecord = null;
        this._masterInfo = null;
        this._masterHealthCheck = null;
    }

    async init() {
        this._init = await this.platform.init();
        // retrieve base config from an S3 bucket
        this._baseConfig = await this.getBaseConfig();
    }

    async handle(event, context, callback) {
        this._step = 'initializing';
        let proxyMethod = 'httpMethod' in event && event.httpMethod, result;
        try {
            await this.init();
            // enter instance termination process if cannot init for any reason
            if (!this._init) {
                result = 'fatal error, cannot initialize.';
                logger.error(result);
                callback(null, proxyResponse(500, result));
            } else if (event.source === 'aws.autoscaling') {
                this._step = 'aws.autoscaling';
                result = await this.handleAutoScalingEvent(event);
                callback(null, proxyResponse(200, result));
            } else if (proxyMethod === 'POST') {
                this._step = 'fortiadc:handleSyncedCallback';
                // authenticate the calling instance
                const instanceId = this.findCallingInstanceId(event);
                if (!instanceId) {
                    callback(null, proxyResponse(403, 'Instance id not provided.'));
                    return;
                }
                result = await this.handleSyncedCallback(event);
                callback(null, proxyResponse(200, result));
            } else if (proxyMethod === 'GET') {
                this._step = 'fortiadc:getConfig';
                result = await this.handleGetConfig(event);
                callback(null, proxyResponse(200, result));
            } else {
                this._step = '¯\\_(ツ)_/¯';

                logger.log(`${this._step} unexpected event!`, event);
                // probably a test call from the lambda console?
                // should do nothing in response
            }

        } catch (ex) {
            if (ex.message) {
                ex.message = `${this._step}: ${ex.message}`;
            }
            try {
                console.error('ERROR while ', this._step, proxyMethod, ex);
            } catch (ex2) {
                console.error('ERROR while ', this._step, proxyMethod, ex.message, ex, ex2);
            }
            if (proxyMethod) {
                callback(null,
                    proxyResponse(500, {
                        message: ex.message,
                        stack: ex.stack
                    }));
            } else {
                callback(ex);
            }
        }

        function proxyResponse(statusCode, res) {
            const response = {
                statusCode,
                headers: {},
                body: typeof res === 'string' ? res : JSON.stringify(res),
                isBase64Encoded: false
            };
            return response;
        }

    }

    /**
     * Submit an election vote for this ip address to become the master.
     * @param {Object} candidateInstance instance of the fortiadc which wants to become the master
     * @param {Object} purgeMasterRecord master record of the old master, if it's dead.
     */
    async putMasterElectionVote(candidateInstance, purgeMasterRecord = null) {
        try {
            const params = {
                TableName: DB.ELECTION.TableName,
                Item: {
                    asgName: process.env.AUTO_SCALING_GROUP_NAME,
                    ip: candidateInstance.PrivateIpAddress,
                    instanceId: candidateInstance.InstanceId,
                    vpcId: candidateInstance.VpcId,
                    subnetId: candidateInstance.SubnetId,
                    voteState: 'pending'
                },
                ConditionExpression: 'attribute_not_exists(asgName)'
            };
            logger.log('masterElectionVote, purge master?', JSON.stringify(purgeMasterRecord));
            if (purgeMasterRecord) {
                try {
                    const purged = await this.purgeMaster(process.env.AUTO_SCALING_GROUP_NAME);
                    logger.log('purged: ', purged);
                } catch (error) {
                    logger.log('no master purge');
                }
            } else {
                logger.log('no master purge');
            }
            return !!await docClient.put(params).promise();
        } catch (ex) {
            console.warn('exception while putMasterElectionVote',
                JSON.stringify(candidateInstance), JSON.stringify(purgeMasterRecord), ex.stack);
            return false;
        }
    }

    async holdMasterElection(instance) {
        // do not need to do anything for master election
        return await instance;
    }

    async electMaster() {
        // return the current master record
        return !!await this.platform.getElectedMaster();
    }
    async checkMasterElection() {
        logger.info('calling checkMasterElection');
        let needElection = false,
            purgeMaster = false,
            electionLock = false,
            electionComplete = false;

        // reload the master
        await this.retrieveMaster(null, true);
        logger.info('current master healthcheck:', JSON.stringify(this._masterHealthCheck));
        // is there a master election done?
        // check the master record and its voteState
        // if there's a complete election, get master health check
        if (this._masterRecord && this._masterRecord.voteState === 'done') {
            // if master is unhealthy, we need a new election
            if (!this._masterHealthCheck ||
                !this._masterHealthCheck.healthy) {
                purgeMaster = needElection = true;
            } else {
                purgeMaster = needElection = false;
            }
        } else if (this._masterRecord && this._masterRecord.voteState === 'pending') {
            // if there's a pending master election, and if this election is incomplete by
            // the end-time, purge this election and starta new master election. otherwise, wait
            // until it's finished
            // needElection = purgeMaster = Date.now() > this._masterRecord.voteEndTime;
            // wait for it to complete
            purgeMaster = needElection = false;
        } else {
            // if no master, try to hold a master election
            needElection = true;
            purgeMaster = false;
        }
        // if we need a new master, let's hold a master election!
        // 2019/01/14 add support for cross-scaling groups election
        // only instance comes from the masterScalingGroup can start an election
        // all other instances have to wait
        if (needElection) {
           
            // try to put myself as the master candidate
            electionLock = await this.putMasterElectionVote(this._selfInstance, purgeMaster);
            if (electionLock) {
                    // yes, you run it!
                logger.info(`This instance (id: ${this._selfInstance.InstanceId})` +
                    ' is running an election.');
                try {
                    // (diagram: elect new master from queue (existing instances))
                    electionComplete = await this.electMaster();
                    logger.info(`Election completed: ${electionComplete}`);
                        // (diagram: master exists?)
                    this._masterRecord = null;
                    this._masterInfo = electionComplete && await this.getMasterInfo();
                    } catch (error) {
                        logger.error('Something went wrong in the master election.');
                    }
                } else {
                    // election returned false, delete the current master info. do the election
                    // again
                    this._masterRecord = null;
                    this._masterInfo = null;
                }
            
        }
        return Promise.resolve(this._masterInfo); // return the new master
    }



    async getConfigSetFromDb(name) {
        const query = {
                TableName: DB.CONFIGSET.TableName,
                Key: {
                    configName: name
                }
            },
            response = await docClient.get(query).promise();
        return response && response.Item && response.Item.configContent;
    }

    async getConfigSetFromS3(configName) {
        let data = await s3.getObject({
            Bucket: process.env.STACK_ASSETS_S3_BUCKET_NAME,
            Key: path.join(process.env.STACK_ASSETS_S3_KEY_PREFIX, 'configset', configName)
        }).promise();

        return data && data.Body && data.Body.toString('ascii');
    }

    // override
    async getBaseConfig() {
        let baseConfig = await this.getConfigSetFromS3('baseconfig');
        if (baseConfig) {
            // check if other config set are required
            let requiredConfigSet = process.env.REQUIRED_CONFIG_SET.split(',');
            let configContent = '', elbWebRequired = false;
            for (let configset of requiredConfigSet) {
                let [name, selected] = configset.trim().split('-');
                if (selected.toLowerCase() === 'yes') {
                    switch (name) {
                        case 'httpsroutingpolicy':
                            elbWebRequired = true;
                            configContent = await this.getConfigSetFromS3(name);
                            break;
                        default:
                            break;
                    }
                }
            }
            if (elbWebRequired) {
                configContent = await this.getConfigSetFromS3('internalelbweb') + configContent;
            }
            baseConfig = baseConfig + configContent;
            let psksecret = process.env.FORTIADC_PSKSECRET;
            baseConfig = baseConfig
                .replace(new RegExp('{SYNC_INTERFACE}', 'gm'),
                    process.env.FORTIADC_SYNC_INTERFACE ?
                        process.env.FORTIADC_SYNC_INTERFACE : 'port1')
                .replace(new RegExp('{PSK_SECRET}', 'gm'), psksecret)
                .replace(new RegExp('{ADMIN_PORT}', 'gm'),
                    process.env.FORTIADC_ADMIN_PORT ? process.env.FORTIADC_ADMIN_PORT : 8443);
        }
        return baseConfig;
    }

    // override
    async getMasterConfig(callbackUrl) {
        // no dollar sign in place holders
        return await this._baseConfig.replace(/\{CALLBACK_URL}/, callbackUrl);
    }

    async getMasterInfo() {
        logger.info('calling getMasterInfo');
        let masterRecord, masterIp;
        try {
            masterRecord = await this.platform.getElectedMaster();
            if (masterRecord === null) {
                return null;
            }
            masterIp = masterRecord.ip;
        } catch (ex) {
            logger.error(ex.message);
        }
        return masterRecord && await this.platform.describeInstance({privateIp: masterIp});
    }

    /* ==== Sub-Handlers ==== */

    /* eslint-disable max-len */
    /**
     * Store the lifecycle transition event details for use later.
     * @param {AWS.Event} event Event who's source is 'aws.autoscaling'.
     * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/EventTypes.html#auto_scaling_event_types
     */
    /* eslint-enable max-len */
    async handleAutoScalingEvent(event) {
        logger.info(`calling handleAutoScalingEvent: ${event['detail-type']}`);
        let result;
        switch (event['detail-type']) {
            case 'EC2 Instance-launch Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_LAUNCHING') {
                    await this.platform.cleanUpDbLifeCycleActions();
                    result = await this.handleLaunchingInstanceHook(event);
                }
                break;
            case 'EC2 Instance-terminate Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_TERMINATING') {
                    await this.platform.cleanUpDbLifeCycleActions();
                    result = await this.handleTerminatingInstanceHook(event);
                }
                break;
            default:
                logger.warn(`Ignore autoscaling event type: ${event['detail-type']}`);
                break;
        }
        return result;
    }

    /* eslint-disable max-len */
    /**
     * Handle the 'auto-scale synced' callback from the fortiadc.
     * @param {AWS.ProxyIntegrationEvent} event Event from the api-gateway.
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format // eslint-disable-line max-len
     */
    /* eslint-enable max-len */
    async handleSyncedCallback(event) {
        const callingInstanceId = this.findCallingInstanceId(event),
            heartBeatInterval = this.findHeartBeatInterval(event),
            fortiadcStatus = this.findFortiADCStatus(event),
            statusSuccess = fortiadcStatus && fortiadcStatus === 'success' || false;
        // if fortiadc is sending callback in response to obtaining config, this is a state
        // message
        let parameters = {}, selfHealthCheck;

        parameters.instanceId = callingInstanceId;
        // handle hb monitor
        // get master instance monitoring
        // let masterInfo = await this.getMasterInfo();
        await this.retrieveMaster();
        // TODO: master health check

        this._selfInstance = await this.platform.describeInstance(parameters);
        // if it is a response from fgt for getting its config
        if (fortiadcStatus) {
            // handle get config callback
            return await this.handleGetConfigCallback(
                this._selfInstance.InstanceId === this._masterInfo.InstanceId, statusSuccess);
        }
        // is myself under health check monitoring?
        // do self health check
        selfHealthCheck = await this.platform.getInstanceHealthCheck({
            instanceId: this._selfInstance.InstanceId
        }, heartBeatInterval);
        // if no record found, this instance not under monitor. should make sure its all
        // lifecycle actions are complete before starting to monitor it
        if (!selfHealthCheck) {
            await this.addInstanceToMonitor(this._selfInstance,
                (Date.now() + heartBeatInterval * 1000), heartBeatInterval);
            logger.info(`instance (id:${this._selfInstance.InstanceId}, ` +
                `ip: ${this._selfInstance.PrivateIpAddress}) is added to monitor.`);
            return {};
        } else {
            logger.info(`instance (id:${this._selfInstance.InstanceId}, ` +
                `ip: ${this._selfInstance.PrivateIpAddress}) health check ` +
                `(${selfHealthCheck.healthy ? 'healthy' : 'unhealthy'}, ` +
                `heartBeatLossCount: ${selfHealthCheck.heartBeatLossCount}, ` +
                `nextHeartBeatTime: ${selfHealthCheck.nextHeartBeatTime}).`);
            if (!selfHealthCheck.healthy) {
               // this happens when 
               // make instance shutdown. go through auto scale terminate process
                return  {
                'action': 'shutdown'
                };
            } else {

                // check if master is healthy. if it is not, try to run a master election
                if (!(this._masterInfo && this._masterHealthCheck &&
                              this._masterHealthCheck.healthy)) 
                {
                    // if no master or master is unhealthy, try to run a master election or check if a
                    // master election is running then wait for it to end
                    // promiseEmitter to handle the master election process by periodically check:
                    // 1. if there is a running election, then waits for its final
                    // 2. if there isn't a running election, then runs an election and complete it
                    let promiseEmitter = this.checkMasterElection.bind(this),
                    // validator set a condition to determine if the fgt needs to keep waiting or not.
                    validator = masterInfo => {
                        // if i am the new master, don't wait, continue to finalize the election.
                        // should return yes to end the waiting.
                        if (masterInfo &&
                            masterInfo.PrivateIpAddress ===
                            this._selfInstance.PrivateIpAddress) {
                            // isMaster = true;
                            return true;
                        } else if (this._masterRecord && this._masterRecord.voteState === 'pending') {
                            
                            // if i am not the new master, and the new master hasn't come up to
                            // finalize the election, I should keep on waiting.
                            // should return false to continue.
                            // this._masterRecord = null; // clear the master record cache
                            return false;
                            
                        } else if (this._masterRecord && this._masterRecord.voteState === 'done') {
                            // if i am not the new master, and the master election is final, then no
                            // need to wait.
                            // should return true to end the waiting.
                            return true;
                        } else {
                            return false;
                            
                        }
                    },
                    // counter to set a time based condition to end this waiting. If script execution
                    // time is close to its timeout (6 seconds - abount 1 inteval + 1 second), ends the
                    // waiting to allow for the rest of logic to run
                    counter = currentCount => { // eslint-disable-line no-unused-vars
                        if (Date.now() < process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 6000) {
                            return false;
                        }
                        logger.warn('script execution is about to expire');
                        return true;
                    };

                    try {
                        this._masterInfo = await AutoScaleCore.waitFor(
                            promiseEmitter, validator, 5000, counter);
                        // after new master is elected, get the new master healthcheck
                        // there are two possible results here:
                        // 1. a new instance comes up and becomes the new master, master healthcheck won't
                        // exist yet because this instance isn't added to monitor.
                        //   1.1. in this case, the instance will be added to monitor.
                        // 2. an existing slave instance becomes the new master, master healthcheck exists
                        // because the instance in under monitoring.
                        //   2.1. in this case, the instance will take actions based on its healthcheck
                        //        result.
                        // this._masterHealthCheck = null; // invalidate the master health check object
                        // reload the master health check object
                        // await this.retrieveMaster(null, true);
                    } catch (error) {
                        // if error occurs, check who is holding a master election, if it is this instance,
                        // terminates this election. then continue
                        await this.retrieveMaster(null, true);

                        if (this._masterRecord.instanceId === this._selfInstance.instanceId ) {
                            await this.platform.removeMasterRecord();
                        }
                        
                        // await this.removeInstance(this._selfInstance);
                        /*
                        throw new Error('Failed to determine the master instance within ' +
                            `${process.env.SCRIPT_EXECUTION_EXPIRE_TIME} seconds. This instance is unable` +
                            ' to bootstrap. Please report this to administrators.');
                        */
                    }
                }
                await this.retrieveMaster(null, true);
                // if this instance is the master instance and the master record is still pending, it will
                // finalize the master election.
                if (this._masterInfo && this._selfInstance.instanceId === this._masterInfo.instanceId &&
                    this._masterRecord && this._masterRecord.voteState === 'pending') {
                    // if election couldn't be finalized, remove the current election so someone else
                    // could start another election
                    if (!await this.platform.finalizeMasterElection()) {
                        await this.platform.removeMasterRecord();
                        this._masterRecord = null;
                    }
                    await this.retrieveMaster(null, true);
                    
                }


                // update instance hb next time
                let now = Date.now();
                await this.platform.updateInstanceHealthCheck(selfHealthCheck, heartBeatInterval, 0, now);
                logger.info(`hb record updated on (timestamp: ${now}, instance id:` +
                `${this._selfInstance.InstanceId}, ` +
                `ip: ${this._selfInstance.PrivateIpAddress}) health check ` +
                `(${selfHealthCheck.healthy ? 'healthy' : 'unhealthy'}, ` +
                `heartBeatLossCount: ${selfHealthCheck.heartBeatLossCount}, ` +
                `nextHeartBeatTime: ${selfHealthCheck.nextHeartBeatTime}.` // +
                // `syncState: ${this._selfHealthCheck.syncState}, master-ip: ${masterIp}).`
                );
                // await this.retrieveMaster(null, true);
                if (this._masterInfo &&
                    this._masterRecord && this._masterRecord.voteState === 'done') {
                    return {'master-ip':this._masterInfo.PrivateIpAddress};
                }
                return {};
                
            }
        }
            
        
    }

    async handleGetConfigCallback(isMaster, statusSuccess) {
        let lifecycleItem, instanceProtected = false;
        lifecycleItem = await this.completeGetConfigLifecycleAction(
                this._selfInstance.InstanceId, statusSuccess) ||
                new AutoScaleCore.LifecycleItem(this._selfInstance.InstanceId, {},
                    AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG);
        // is it master?
        if (isMaster) {
            try {
                // then protect it from scaling in
                // instanceProtected =
                //         await this.platform.protectInstanceFromScaleIn(
                //             process.env.AUTO_SCALING_GROUP_NAME, lifecycleItem);
                logger.info(`Instance (id: ${lifecycleItem.instanceId}) scaling-in` +
                    ` protection is on: ${instanceProtected}`);
            } catch (ex) {
                logger.warn('Unable to protect instance from scale in:', ex);
            }
            // update master election from 'pending' to 'done'
            await this.platform.finalizeMasterElection();
        }
        logger.info('called handleGetConfigCallback');
        return {};
    }

    async completeGetConfigLifecycleAction(instanceId, success) {
        logger.info('calling completeGetConfigLifecycleAction');
        let items = await this.platform.getLifecycleItems(instanceId);
        items = items.filter(item => {
            return item.actionName === AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG;
        });
        if (Array.isArray(items) && items.length === 1 && !items[0].done) {
            items[0].done = true;
            let complete = await this.platform.completeLifecycleAction(items[0], success);
            logger.info(`called completeGetConfigLifecycleAction. complete: ${complete}`);
            return items[0];
        } else {
            return items && items[0];
        }
    }

    async handleLaunchingInstanceHook(event) {
        logger.info('calling handleLaunchingInstanceHook');
        const instanceId = event.detail.EC2InstanceId,
            item = new AutoScaleCore.LifecycleItem(instanceId, event.detail,
                AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG, false),
            result = await this.platform.updateLifecycleItem(item);
        logger.info(`FortiADC (instance id: ${instanceId}) is launching to get config, ` +
            `lifecyclehook(${event.detail.LifecycleActionToken})`);
        return result;
    }

    async handleTerminatingInstanceHook(event) {
        logger.info('calling handleTerminatingInstanceHook');
        let instanceId = event.detail.EC2InstanceId,
            item = new AutoScaleCore.LifecycleItem(instanceId, event.detail,
            AutoScaleCore.LifecycleItem.ACTION_NAME_TERMINATING_INSTANCE, false);
        // check if master
        let masterRecord = await this.platform.getElectedMaster();
        logger.log(`masterRecord: ${JSON.stringify(masterRecord)}`);
        logger.log(`lifecycle item: ${JSON.stringify(item)}`);
        if (masterRecord && masterRecord.instanceId === item.instanceId) {
            await this.deregisterMasterInstance(masterRecord);
        }
        await this.platform.completeLifecycleAction(item, true);
        await this.platform.cleanUpDbLifeCycleActions([item], true);
        await this.platform.deleteInstanceHealthCheck(instanceId);
        logger.info(`FortiADC (instance id: ${instanceId}) is terminating, lifecyclehook(${
            event.detail.LifecycleActionToken})`);
        return;
    }

    async addInstanceToMonitor(instance, nextHeartBeatTime, heartBeatInterval = 10) {
        logger.info('calling addInstanceToMonitor');
        var params = {
            Item: {
                instanceId: instance.InstanceId,
                ip: instance.PrivateIpAddress,
                autoScalingGroupName: process.env.AUTO_SCALING_GROUP_NAME,
                nextHeartBeatTime: nextHeartBeatTime,
                heartBeatLossCount: 0,
                heartBeatInterval: heartBeatInterval
            },
            TableName: DB.AUTOSCALE.TableName
        };
        return await docClient.put(params).promise();
    }


    async retrieveMaster(filters = null, reload = false) {
       
        if (reload) {
            this._masterInfo = null;
            this._masterHealthCheck = null;
            this._masterRecord = null;
        }
        if (!this._masterInfo && (!filters || filters && filters.masterInfo)) {
            this._masterInfo = await this.getMasterInfo();
        }
        
          
        if (!this._masterHealthCheck && (!filters || filters && filters.masterHealthCheck)) {
            if (!this._masterInfo) {
                this._masterInfo = await this.getMasterInfo();
            }
            if (this._masterInfo) {
                // TODO: master health check should not depend on the current hb
                this._masterHealthCheck = await this.platform.getInstanceHealthCheck({
                    instanceId: this._masterInfo.InstanceId
                });
            }
        }
        
        
        if (!this._masterRecord && (!filters || filters && filters.masterRecord)) {
            this._masterRecord = await this.platform.getElectedMaster();
        }
        
        return {
            masterInfo: this._masterInfo,
            masterHealthCheck: this._masterHealthCheck,
            masterRecord: this._masterRecord
        };
    }

    async purgeMaster(asgName) {
        const params = {
            TableName: DB.ELECTION.TableName,
            Key: { asgName: asgName },
            ConditionExpression: '#AsgName = :asgName',
            ExpressionAttributeNames: {
                '#AsgName': 'asgName'
            },
            ExpressionAttributeValues: {
                ':asgName': asgName
            }
        };
        return await docClient.delete(params).promise();
    }

    async deregisterMasterInstance(instance) {
        logger.info('calling deregisterMasterInstance', JSON.stringify(instance));
        return await this.purgeMaster(process.env.AUTO_SCALING_GROUP_NAME);
    }

    /* eslint-disable max-len */
    /**
     * Handle the 'getConfig' callback from the fortiadc.
     * @param {Aws.ProxyIntegrationEvent} event Event from the api-gateway.
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format // eslint-disable-line max-len
     */
    /* eslint-enable max-len */
    async handleGetConfig(event) {
        logger.info('calling handleGetConfig');
        let
            // masterIsHealthy = false,
            config,
            // getConfigTimeout,
            // nextTime,
            masterInfo,
            // masterHealthCheck,
            // masterRecord,
            // masterIp,
            callingInstanceId = this.findCallingInstanceId(event);

        // get instance object from platform
        this._selfInstance = await this.platform.describeInstance({instanceId: callingInstanceId});
        if (!this._selfInstance || this._selfInstance.VpcId !== process.env.VPC_ID) {
            // not trusted
            throw new Error(`Unauthorized calling instance (instanceId: ${callingInstanceId}).` +
            'Instance not found in VPC.');
        }
        // await this.retrieveMaster(null, true);

        let promiseEmitter = this.checkMasterElection.bind(this),
            validator = result => {
             
               if (this._masterRecord && this._masterRecord.voteState === 'pending' &&
                   this._selfInstance &&
                    this._masterRecord.instanceId === this._selfInstance.InstanceId) {
                    // masterIp = this._masterRecord.ip;
                    return true;
                }

                // if neither a pending master nor a master instance is found on the master
                // scaling group. and if master-election-no-wait is enabled, allow this fgt
                // to wake up without a master ip.
                // this also implies this instance cannot be elected as the next maste which
                // means it should be a slave.

                // master info exists
                if (result) {
                    // i am the elected master
                    if (result.PrivateIpAddress ===
                        this._selfInstance.PrivateIpAddress) {
                        // masterIp = this._selfInstance.primaryPrivateIpAddress;
                        return true;
                    } else if (this._masterRecord) {
                        // i am not the elected master, how is the master election going?
                        if (this._masterRecord.voteState === 'done') {
                            // master election done
                            return true;
                        } else if (this._masterRecord.voteState === 'pending') {
                            // master is still pending
                            return false;
                        }
                    } else {
                        // master info exists but no master record?
                        // this looks like a case that shouldn't happen. do the election again?
                        logger.warn('master info found but master record not found. retry.');
                        return false;
                    }
                } else {
                    // master cannot be elected but I cannot be the next elected master either
                    // if not wait for the master election to complete, let me become headless
                    return false;
                }
            },
            counter = () => {
                if (Date.now() < process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 3000) {
                    return false;
                }
                logger.warn('script execution is about to expire');
                return true;
            };
        try {
           masterInfo = await AutoScaleCore.waitFor(
           promiseEmitter, validator, 5000, counter);
        } catch (error) {
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            } else {
                message = error && typeof error.toString === 'function' ?
                        error.toString() : JSON.stringify(error);
            }
            logger.warn(message);
            // if error occurs, check who is holding a master election, if it is this instance,
            // terminates this election. then tear down this instance whether it's master or not.
            await this.retrieveMaster(null, true);
            // this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
            if (this._masterRecord.instanceId === this._selfInstance.InstanceId) {
                await this.platform.removeMasterRecord();
            }
            await this.platform.removeInstance(this._selfInstance);
            throw new Error('Failed to determine the master instance. This instance is unable' +
                ' to bootstrap. Please report this to' +
                ' administrators.');
        }
        // await this.retrieveMaster(null, true);
        // the master ip same as mine? (diagram: master IP same as mine?)
        if (masterInfo.PrivateIpAddress === this._selfInstance.PrivateIpAddress) {
            this._step = 'handler:getConfig:getMasterConfig';
            config = await this.getMasterConfig(await this.platform.getCallbackEndpointUrl());
            logger.info('called handleGetConfig: returning master config' +
            `(master-ip: ${masterInfo.PrivateIpAddress}):\n ${config}`);
            return config;
        } else {

            this._step = 'handler:getConfig:getSlaveConfig';
            config = this.getSlaveConfig(masterInfo.PrivateIpAddress,
                await this.platform.getCallbackEndpointUrl(), process.env.FORTIADC_SYNC_INTERFACE, process.env.FORTIADC_PSKSECRET, process.env.FORTIADC_ADMIN_PORT);
            /*
            config = await this.getSlaveConfig(masterInfo.PrivateIpAddress,
                await this.platform.getCallbackEndpointUrl(), process.env.FORTIADC_SYNC_INTERFACE, process.env.FORTIADC_PSKSECRET, process.env.FORTIADC_ADMIN_PORT);
            */
            logger.info('called handleGetConfig: returning slave config' +
                `(master-ip: ${masterInfo.PrivateIpAddress}):\n ${config}`);
            return config;
        }
    }

    /* ==== Utilities ==== */

    findCallingInstanceIp(request) {
        if (request.headers && request.headers['X-Forwarded-For']) {
            logger.info(`called findCallingInstanceIp: Ip (${request.headers['X-Forwarded-For']})`);
            return request.headers['X-Forwarded-For'];
        } else if (request.requestContext && request.requestContext.identity &&
            request.requestContext.identity.sourceIp) {
            logger.info('called findCallingInstanceIp: ' +
            `Ip (${request.requestContext.identity.sourceIp})`);
            return request.requestContext.identity.sourceIp;
        } else {
            logger.error('called findCallingInstanceIp: instance Ip not found' +
                `. original request: ${JSON.stringify(request)}`);
            return null;
        }
    }

    findCallingInstanceId(request) {
        if (request.headers && request.headers['Fadc-instance-id']) {
            logger.info('called findCallingInstanceId: instance Id ' +
            `(${request.headers['Fadc-instance-id']}) found.`);
            return request.headers['Fadc-instance-id'];
        } else if (request.body) {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                logger.info('called findCallingInstanceId: instance Id ' +
            `(${jsonBodyObject.instance}) found.`);
                return jsonBodyObject.instance;
            } catch (ex) {
                logger.info('called findCallingInstanceId: unexpected body content format ' +
            `(${request.body})`);
                return null;
            }
        } else {
            logger.error('called findCallingInstanceId: instance Id not found' +
                `. original request: ${JSON.stringify(request)}`);
            return null;
        }
    }

    findHeartBeatInterval(request) {
        if (request.body && request.body !== '') {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                logger.info('called findHeartBeatInterval: interval ' +
            `(${jsonBodyObject.interval}) found.`);
                return jsonBodyObject.interval;
            } catch (ex) {
                logger.info('called findCallingInstanceId: unexpected body content format ' +
            `(${request.body})`);
                return null;
            }

        } else {
            logger.error('called findHeartBeatInterval: interval not found' +
                `. original request: ${JSON.stringify(request)}`);
            return null;
        }
    }

    findFortiADCStatus(request) {
        if (request.body && request.body !== '') {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                if (jsonBodyObject.status) {
                    logger.info('called findFortiADCStatus: ' +
                    `status ${jsonBodyObject.status} found`);
                } else {
                    logger.info('called findFortiADCStatus: status not found');
                }
                return jsonBodyObject.status;
            } catch (ex) {
                logger.info('called findFortiADCStatus: unexpected body content format ' +
            `(${request.body})`);
                return null;
            }
        }
    }

    async findCallingInstance(request) {
        const localIp = this.findCallingInstanceIp(request);
        if (!localIp) {
            throw Error('X-Forwarded-For and requestContext do not contain the instance local ip');
        }
        return await this.platform.findInstanceIdByIp(localIp);
    }

}

exports.AutoScaleCore = AutoScaleCore; // get a reference to the core
exports.AwsPlatform = AwsPlatform;
exports.AwsAutoscaleHandler = AwsAutoscaleHandler;

/**
 * Initialize the module to be able to run via the 'handle' function.
 * Otherwise, this module only exposes some classes.
 * @returns {Object} exports
 */
exports.initModule = () => {
    process.env.SCRIPT_EXECUTION_TIME_CHECKPOINT = Date.now();

    AWS.config.update({
        region: process.env.AWS_REGION
    });
    /**
     * expose the module runtime id
     * @returns {String} a unique id.
     */
    exports.moduleRuntimeId = () => moduleId;
    /**
     * Handle the auto-scaling
     * @param {Object} event The event been passed to
     * @param {Object} context The Lambda function runtime context
     * @param {Function} callback a callback function been triggered by AWS Lambda mechanism
     */
    exports.handler = async (event, context, callback) => {
        process.env.SCRIPT_EXECUTION_EXPIRE_TIME = Date.now() + context.getRemainingTimeInMillis();
        logger = new AutoScaleCore.DefaultLogger(console);
        const handler = new AwsAutoscaleHandler();
        await handler.handle(event, context, callback);
    };
    return exports;
};
