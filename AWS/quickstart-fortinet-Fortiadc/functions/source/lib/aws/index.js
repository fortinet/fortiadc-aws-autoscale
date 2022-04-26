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
                },
                {
                    AttributeName: 'voteEndTime',
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
            TableName: `${custom_id}-FortiadcPrimaryElection-${unique_id}`
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
            await dynamodb.createTable(schema, function(err, data) {
                if (err) logger.log(`create table ${schema.TableName} failed: ${err}, ${err.stack} `); // an error occurred
                else     logger.log(`create table ${schema.TableName} success: ${data}`);           // successful response
            }).promise();
        }
        await dynamodb.waitFor('tableExists', {TableName: schema.TableName}).promise();
    }

    async tableExists(schema) {
        try {
            await dynamodb.describeTable({ TableName: schema.TableName }).promise();
            logger.log('found table', schema.TableName);
            return true;
        } catch (ex) {
            logger.error(`table (${schema.TableName}) not exists!`);
            await this.createTable(schema);
            return true;
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
     * Get the ip address which won the primary election
     * @returns {Object} Primary record of the fortiadc which should be the auto-sync primary
     */
    async getElectedPrimary() {
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
            logger.info('No elected primary was found in the db!');
            return null;
        }
        logger.info(`Elected primary found: ${JSON.stringify(items[0])}`, JSON.stringify(items));
        return items[0];
    }
    async removePrimaryRecord() {
        const params = {
            TableName: DB.ELECTION.TableName,
            Key: {
                asgName: process.env.AUTO_SCALING_GROUP_NAME
            } 
        };
        return await docClient.delete(params).promise();
    }
    async attachElasticIP(instanceId) {
        try {
            logger.log(`${instanceId} calling attachElasticIP`);
            let elasticIP = process.env.ElasticIP;
    
            let asso_params = {
                AllowReassociation: true,
                PublicIp: elasticIP,
                InstanceId: instanceId
            };
            let result1 = await ec2.associateAddress(asso_params).promise();
            logger.log('EIP association result' + `${JSON.stringify(result1)}`);
        } catch (ex) {
            logger.warn(`${instanceId} called attachElasticIP, error:`, ex.stack);
            return false;
        }
    }

    async finalizePrimaryElection(instanceID, primary_record = null) {
        try {
            logger.info(`${instanceID} calling finalizePrimaryElection`);
            let electedPrimary, elected_id;
            if (!primary_record) electedPrimary = await this.getElectedPrimary();
            else electedPrimary = primary_record;
            electedPrimary.voteState = 'done';
            elected_id = electedPrimary.instanceId;
            logger.info(`hello : ${JSON.stringify(electedPrimary)}`);
            const params = {
                TableName: DB.ELECTION.TableName,
                Item: electedPrimary
            };
            let result = await docClient.put(params, function(err, data) {
                if (err) {logger.info(`${instanceID} called finalizePrimaryElection, result: ${JSON.stringify(err)}`);}
            }).promise();
            
            await this.attachElasticIP(electedPrimary.instanceId);
            logger.info(`${instanceID} called finalizePrimaryElection, result: ${JSON.stringify(result)}`);
            return result;
        } catch (ex) {
            logger.warn(`${instanceID} called finalizePrimaryElection, error:`, ex.stack);
            return false;
        }
    }
    async addConfig(heartBeatLossCount = 5, heartDelayAllowance = 60) {
        var searchparams = {
            Key: {
                configName: 'heartBeatAllowLossCount'
            },
            TableName: DB.CONFIGSET.TableName
        };
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
        };
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
        
        return [heartBeatLossCount, heartDelayAllowance];
    }
    async addConfigSyncPort(cfgsyncport = 10443) {
        let port = 10443;
        if (cfgsyncport != -1) {
            port = cfgsyncport;
        }
        var searchparams = {
            Key: {
                configName: 'configSyncPort'
            },
            TableName: DB.CONFIGSET.TableName
        };
        var params = {
            Item: {
                configName: 'configSyncPort',
                value: port
            },
            TableName: DB.CONFIGSET.TableName
        };
        var data = await docClient.get(searchparams).promise();
        if (!data.Item) {
            console.log('no configSyncPort');
            await docClient.put(params).promise();
            return port;
        } else {
            if (cfgsyncport != -1 && data.Item.value != cfgsyncport) {
                params = {
                    Item: {
                        configName: 'configSyncPort',
                        value: cfgsyncport
                    },
                    TableName: DB.CONFIGSET.TableName
                };
                await docClient.put(params).promise();
                return cfgsyncport;
            }
            return data.Item.value;
        }
    }
    async addFortiADCImageVersion(image, is_primary=false) {
        
        var searchparams = {
            Key: {
                configName: 'FortiADCImageVersion'
            },
            TableName: DB.CONFIGSET.TableName
        };
        var params = {
            Item: {
                configName: 'FortiADCImageVersion',
                value: image
            },
            TableName: DB.CONFIGSET.TableName
        };
        
        if (is_primary) {
            console.log(`Update FortiADC Image Version to ${image}`);
            await docClient.put(params).promise();
            return image;
        }
        var data = await docClient.get(searchparams).promise();
        if (data && data.Item) {
            return data.Item.value;
        }
        return "";
    }
    async getInstanceBornTime(instanceId) {
        if (!instanceId) {
            logger.error('getInstanceBornTime > error: no instanceId property found' +
            ` on instance: ${instanceId}`);
            return -1;
        }
        var params = {
            Key: {
                instanceId: instanceId
            },
            TableName: DB.AUTOSCALE.TableName
        };
       
            
        let data = await docClient.get(params).promise();
        if (!data.Item) {
             logger.error('getInstanceBornTime > error: no instance found' +
            ` on instance: ${instanceId}`);
            return -1;
        }
        
        return data.Item.bornTime;
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
            // The inevitable-fail-to-sync time is defined as:
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
                logger.info(`Instance ${instance.instanceId}: hb sync is late${heartBeatLossCount > 1 ? ' again' : ''}.\n` +
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
                `${scriptExecutionStartTime},  interval:${interval})` +
                'healthcheck record:',
                JSON.stringify(healthCheckRecord));
            return {
                instanceId: instance.instanceId,
                ip: healthCheckRecord.ip || '',
                healthy: healthy,
                heartBeatLossCount: heartBeatLossCount,
                heartBeatInterval: interval,
                nextHeartBeatTime: Date.now() + interval * 1000,
                inevitableFailToSyncTime: inevitableFailToSyncTime,
                healthCheckTime: scriptExecutionStartTime
            };

        } catch (error) {
            logger.info('called getInstanceHealthCheck with error. ' +
            `error: ${JSON.stringify(error)}`);
            return null;
        }
    }
    async updateInstanceHealthCheck(healthCheckObject, heartBeatInterval, primaryIp, checkPointTime,
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
    async removeOutdatedInstanceHealthCheck(aliveinstanceId) {
        try {
            let 
                awaitAll = [],
                unhealthyInstances = [],
                data = await docClient.scan({
                    TableName: DB.AUTOSCALE.TableName
                }).promise();

            let items = data.Items;
            if (!(items && items.length)) {
                logger.info('removeOudatedInstanceHealthCheck: there is no healthcheck item');
                return null;
            }
            var params = {
                AutoScalingGroupNames: [
                    process.env.AUTO_SCALING_GROUP_NAME,
             ]
            };
            let autoscaledata = await autoScaling.describeAutoScalingGroups(params).promise();
            let instance_ids = [];
    
            autoscaledata.AutoScalingGroups.forEach(asg_resp => {
                asg_resp.Instances.forEach(instance => {
                    if (instance.LifecycleState === "InService") {
                        instance_ids.push(instance.InstanceId);
                    }
                });
            });
            
            let item_healthy = async item => {
                if (item.instanceId === aliveinstanceId) {
                    return true;
                }
                if (instance_ids.includes(item.instanceId)) {
                    return true;
                }
                unhealthyInstances.push(item.instanceId);
                return false;
            };
            items.forEach(item => {
                awaitAll.push(item_healthy(item));
            });
            await Promise.all(awaitAll);
            
            if (unhealthyInstances.length === 0) {
                logger.info('removeOudatedInstanceHealthCheck: no unhealthy instances');
                return null;
            }
            awaitAll = [];
            let deleteUnhealthItem = async instanceId => {
                return await this.deleteInstanceHealthCheck(instanceId);
            };
            
            unhealthyInstances.forEach(instanceId => {
                awaitAll.push(deleteUnhealthItem(instanceId));
            });
            logger.info('called removeOudatedInstanceHealthCheck');
        } catch (error) {
            logger.info('called removeOudatedInstanceHealthCheck with error. ' +
            `error: ${JSON.stringify(error)}`);
            return null;
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
        if (parameters.instanceId) {
            logger.info(`${parameters.instanceId}: `+'calling describeInstance');
        } else {
            logger.info('calling describeInstance');
        }
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
        logger.info(`${parameters.instanceId}: called describeInstance, result: ${JSON.stringify(result)}`);
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
        this._primaryRecord = null;
        this._primaryInfo = null;
        this._primaryHealthCheck = null;
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
                this._step = '';

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
     * Submit an election vote for this ip address to become the primary.
     * @param {Object} candidateInstance instance of the fortiadc which wants to become the primary
     * @param {Object} purgePrimaryRecord primary record of the old primary, if it's dead.
     */
    async putPrimaryElectionVote(candidateInstance, original_primary_id = "", purgePrimaryRecord = null) {
        //Elect the instance with state "InService" and with the earliest born time
        try {
            let params = {
                TableName: DB.ELECTION.TableName,
                Item: {
                    asgName: process.env.AUTO_SCALING_GROUP_NAME,
                    ip: candidateInstance.PrivateIpAddress,
                    instanceId: candidateInstance.InstanceId,
                    vpcId: candidateInstance.VpcId,
                    subnetId: candidateInstance.SubnetId,
                    voteState: 'pending',
                    voteEndTime: process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 6000
                    
                },
                ConditionExpression: 'attribute_not_exists(asgName)'
            };
            logger.log(`PrimaryElectionVote, purge Primary ${original_primary_id} ?`, JSON.stringify(purgePrimaryRecord));
            if (purgePrimaryRecord) {
                try {
                    let purged = await this.purgePrimary(process.env.AUTO_SCALING_GROUP_NAME);
                    logger.log('purged primary : ', purged);
                    if (original_primary_id){
                        await this.deleteInstanceHealthCheck(original_primary_id);
                    }
                } catch (error) {
                    logger.log('no Primary purge');
                }
            } else {
                logger.log('no Primary purge');
            }
            //select new Primary
            
            let healthyInstances = [],
                InserviceInstances = [],
                awaitAll = [],
                bornTimesInstances = [];
            var autosclaing_params = {
                AutoScalingGroupNames: [
                    process.env.AUTO_SCALING_GROUP_NAME,
                ]
            };
            let autoscaledata = await autoScaling.describeAutoScalingGroups(autosclaing_params).promise();
        
            autoscaledata.AutoScalingGroups.forEach(asg_resp => {
                asg_resp.Instances.forEach(instance => {
                    if (instance.LifecycleState === "InService" && instance.InstanceId != original_primary_id) {
                        //should exclude the original primary
                        InserviceInstances.push(instance.InstanceId);
                    }
                });
            });
            
            if (!(InserviceInstances && InserviceInstances.length)) {
                logger.info('putPrimaryElectionVote() called, but no instance in service. At init stage!');
                logger.info(`Put calling instance ${candidateInstance.InstanceId} into election`);
                return !!await docClient.put(params).promise();
                
            }
            logger.log(`InService instance count(${InserviceInstances.length}), members: (${JSON.stringify(InserviceInstances)})`);
        
            let gethealthyitem = async instanceId => {
                let hcresult = await this.platform.getInstanceHealthCheck({
            instanceId: instanceId});
                if (!hcresult) {
                   logger.log('No healthcheck record. It is at init stage');
                }
                if (!hcresult || hcresult.healthy) {
                    healthyInstances.push(instanceId);
                }
            };
            InserviceInstances.forEach(instanceId => {
                awaitAll.push(gethealthyitem(instanceId));
            });
            await Promise.all(awaitAll);
            awaitAll = [];
            if (!(healthyInstances && healthyInstances.length)) {
                logger.error('putPrimaryElectionVote() called, but no healthy instance found. ' +
                            'should not happen!');
                return false;
                
            }
            logger.log(`HealthyInstances count(${healthyInstances.length}), members: (${JSON.stringify(healthyInstances)})`);
            
            let getBornTime = async instanceId => {
                let bornTime = await this.platform.getInstanceBornTime(instanceId);
                if (bornTime > 0) {
                    bornTimesInstances.push({instanceId: instanceId, bornTime: bornTime});
                }
            };
            healthyInstances.forEach(instanceId => {
                awaitAll.push(getBornTime(instanceId));
            });
            await Promise.all(awaitAll);
            logger.info(`bornTimesInstances count(${bornTimesInstances.length}),` +
                        `members: (${JSON.stringify(bornTimesInstances)})`);
            if (!(bornTimesInstances && bornTimesInstances.length)) {
                logger.info('putPrimaryElectionVote() called, but no bornTimes found. The instance may not send sync callback yet');
                logger.info(`Put calling instance ${candidateInstance.InstanceId} into election`);
                return !!await docClient.put(params).promise();
            }

            let eaylyestTime = 0,
                primaryInstanceId = null;
            bornTimesInstances.forEach(bornTimesInstance => {
                let bornTime = bornTimesInstance.bornTime;
                if (eaylyestTime === 0) {
                    eaylyestTime = bornTime;
                    primaryInstanceId = bornTimesInstance.instanceId;
                } else if (bornTime < eaylyestTime) {
                    eaylyestTime = bornTime;
                    primaryInstanceId = bornTimesInstance.instanceId;
                }
            });
            if (primaryInstanceId === null) {
                logger.error('putPrimaryElectionVote() called, but no earlyest instance found. ' +
                            'should not happen!');
                logger.error(`Put calling instance ${candidateInstance.InstanceId} into election due to no earlyest instance found`);
                return !!await docClient.put(params).promise();
            }
            logger.info(`new selected primary (instanceId: ${primaryInstanceId})`);
            let seeded_primary = await this.platform.describeInstance({instanceId: primaryInstanceId});
            params = {
                TableName: DB.ELECTION.TableName,
                Item: {
                    asgName: process.env.AUTO_SCALING_GROUP_NAME,
                    ip: seeded_primary.PrivateIpAddress,
                    instanceId: seeded_primary.InstanceId,
                    vpcId: seeded_primary.VpcId,
                    subnetId: seeded_primary.SubnetId,
                    voteState: 'pending',
                    voteEndTime: process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 6000
                },
                ConditionExpression: 'attribute_not_exists(asgName)'
            };
            return !!await docClient.put(params).promise();
        } catch (ex) {
            console.warn('exception while putPrimaryElectionVote',
                JSON.stringify(candidateInstance), JSON.stringify(purgePrimaryRecord), ex.stack);
            return false;
        }
    }

    async holdPrimaryElection(instance) {
        // do not need to do anything for primary election
        return await instance;
    }

    async checkPrimaryElection() {
        logger.info(`${this._selfInstance.InstanceId}: ` + 'calling checkPrimaryElection');
        let needElection = false,
            purgePrimary = false,
            electionLock = false,
            electionComplete = false,
            original_primary_id = "";

        // reload the primary
        await this.retrievePrimary(null, true);
        if (this._primaryRecord) {
            original_primary_id = this._primaryRecord.instanceId;
        }
        logger.info('current primary node healthcheck:', JSON.stringify(this._primaryHealthCheck));
        
        
        if (this._primaryRecord && this._primaryRecord.voteState === 'done') {
            // if primary is unhealthy, we need a new election
            if (!this._primaryHealthCheck ||
                !this._primaryHealthCheck.healthy) {
                purgePrimary = needElection = true;
            } else {
                purgePrimary = needElection = false;
            }
        } else if (this._primaryRecord && this._primaryRecord.voteState === 'pending') {
            // if there's a pending primary election, and if this election is incomplete by
            // the end-time, purge this election and start a new primary election. otherwise, wait
            // until it's finished
            needElection = purgePrimary = Date.now() > this._primaryRecord.voteEndTime;
            if (needElection) {
                logger.warn('Elected primary '+ this._primaryRecord.instanceId + ' is pending timeout. Purge it.');
            }
        } else {
            // if no primary, try to hold a primary election
            needElection = true;
            purgePrimary = false;
        }
        if (needElection) {
           
            // try to put myself as the primary candidate
            electionLock = await this.putPrimaryElectionVote(this._selfInstance, original_primary_id, purgePrimary);
            if (electionLock) {
                try {
                    this._primaryRecord = await this.platform.getElectedPrimary();
                    electionComplete = !!this._primaryRecord;
                    logger.info(`Election completed: ${electionComplete}`);
                    this._primaryInfo = electionComplete && await this.getPrimaryInfo(this._primaryRecord.instanceId, this._primaryRecord.ip);
                    this._primaryRecord = null;
                    
                    } catch (error) {
                        logger.error('Something went wrong in the primary election.');
                    }
            } else {
                // election returned false, delete the current primary info. do the election
                // again
                this._primaryRecord = null;
                this._primaryInfo = null;
            }
        }
        return Promise.resolve(this._primaryInfo); // return the new primary
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

            baseConfig = baseConfig
                .replace(new RegExp('{SYNC_INTERFACE}', 'gm'),
                    process.env.FORTIADC_SYNC_INTERFACE ?
                        process.env.FORTIADC_SYNC_INTERFACE : 'port1')
                .replace(new RegExp('{ADMIN_PORT}', 'gm'),
                    process.env.FORTIADC_ADMIN_PORT ? process.env.FORTIADC_ADMIN_PORT : 8443);
        }
        return baseConfig;
    }

    // override
    async getPrimaryConfig(callbackUrl) {
        // no dollar sign in place holders
        return await this._baseConfig.replace(/\{CALLBACK_URL}/, callbackUrl);
    }

    async getPrimaryInfo(instanceId, primaryIp) {
        logger.info('calling getPrimaryInfo');
       
        return await this.platform.describeInstance({instanceId:instanceId, privateIp: primaryIp});
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
                /*
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_TERMINATING') {
                    await this.platform.cleanUpDbLifeCycleActions();
                    result = await this.handleTerminatingInstanceHook(event);
                }
                */
                
                break;
            case 'EC2 Instance Terminate Successful':
                await this.platform.cleanUpDbLifeCycleActions();
                result = await this.handleTerminatingInstanceHook(event);
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
        let parameters = {}, selfHealthCheck;

        parameters.instanceId = callingInstanceId;
        //check if the instance is in ASG
        var params = {
          InstanceIds: [
            callingInstanceId
          ]
        };
        let data = await autoScaling.describeAutoScalingInstances(params).promise();

        if (data && data.AutoScalingInstances.length) {
            var callinginstance = data.AutoScalingInstances[0];
            if (callinginstance.AutoScalingGroupName != process.env.AUTO_SCALING_GROUP_NAME ) {
                logger.warn(`instance ${callingInstanceId} is not in ASG: ${process.env.AUTO_SCALING_GROUP_NAME}`);
                this._primaryRecord = await this.platform.getElectedPrimary();
                if (this._primaryRecord && callingInstanceId === this._primaryRecord.instanceId){
                    await this.platform.removePrimaryRecord();
                }
                await this.platform.deleteInstanceHealthCheck(callingInstanceId);
                return  {
                    'action': 'disable-autoscale'
                };
            }
        } else {
            logger.warn(`instance ${callingInstanceId} is not in ASG: ${process.env.AUTO_SCALING_GROUP_NAME}`);
            this._primaryRecord = await this.platform.getElectedPrimary();
            if (this._primaryRecord && callingInstanceId === this._primaryRecord.instanceId) {
                    await this.platform.removePrimaryRecord();
            }
            await this.platform.deleteInstanceHealthCheck(callingInstanceId);
            return  {
                'action': 'disable-autoscale'
            };
        }
        logger.info(`instance ${callingInstanceId} is in ASG: ${process.env.AUTO_SCALING_GROUP_NAME}`);
        await this.retrievePrimary();
        
        
        this._selfInstance = await this.platform.describeInstance(parameters);
        // if it is a response from fad for getting its config and add itself to hb monitor 
        if (fortiadcStatus) {
            if (this._primaryInfo && this._primaryRecord) {
                await this.handleGetConfigCallback(
                    this._selfInstance.InstanceId === this._primaryInfo.InstanceId, statusSuccess, this._primaryRecord);
            }
        }
        
        if (this._primaryInfo && this._primaryRecord) {
            let image_compatible = await this.checkFortiADCImageVersion(event, this._selfInstance.InstanceId === this._primaryInfo.InstanceId);
            if (!image_compatible) {
                return{};
            }
        }
        
        selfHealthCheck = await this.platform.getInstanceHealthCheck({
            instanceId: this._selfInstance.InstanceId
        }, heartBeatInterval);
        
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
               // make instance shutdown. go through auto scale terminate process
               /*
                return  {
                'action': 'shutdown'
                };
                */
                //As I am unhealthy, I can't be the primary node, wait for the new primary.
                if (this._primaryInfo && this._selfInstance.InstanceId != this._primaryInfo.InstanceId) {
                    let now = Date.now();
                    selfHealthCheck.heartBeatLossCount = 0;
                    await this.platform.updateInstanceHealthCheck(selfHealthCheck, heartBeatInterval, 0, now);
                    logger.info(`hb record updated on (timestamp: ${now}, instance id:` +
                    `${this._selfInstance.InstanceId} is back on the track.`
                    );
                }
            } else {

                //check if I am running the primary election
                if (this._primaryInfo && this._selfInstance.InstanceId === this._primaryInfo.InstanceId &&
                    this._primaryRecord && this._primaryRecord.voteState === 'pending') {
                     
                    if (!await this.platform.finalizePrimaryElection(this._selfInstance.InstanceId, this._primaryRecord)) {
                        //can't finalize the election, let others run it by pending timeout
                    } else {
                        this._primaryRecord.voteState = 'done';
                    }
                } else if (!(this._primaryInfo && this._primaryHealthCheck &&
                              this._primaryHealthCheck.healthy)) 
                {
                    // if no primary or primary is unhealthy, try to hold a primary election
                    let promiseEmitter = this.checkPrimaryElection.bind(this),
                    // validator set a condition to determine if the fad needs to keep waiting or not.
                    validator = primaryInfo => {
                        // if i am the new primary, don't wait, continue to finalize the election.
                        // should return yes to end the waiting.
                        if (primaryInfo &&
                            primaryInfo.PrivateIpAddress ===
                            this._selfInstance.PrivateIpAddress) {
                            return true;
                        } else if (this._primaryRecord && this._primaryRecord.voteState === 'pending') {
                            // if i am not the new primary, and the new primary hasn't come up to
                            // finalize the election, I should keep on waiting.
                            // should return false to continue.
                            return false;
                            
                        } else if (this._primaryRecord && this._primaryRecord.voteState === 'done') {
                            // if i am not the new primary, and the primary election is final, then no
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
                    counter = currentCount => {
                        if (Date.now() < process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 3000) {
                            return false;
                        }
                        logger.warn('script execution is about to expire');
                        return true;
                    };

                    try {
                        this._primaryInfo = await AutoScaleCore.waitFor(
                            promiseEmitter, validator, 5000, counter);
                        logger.info(`${this._selfInstance.InstanceId}: Check primary election done`);
                        await this.retrievePrimary(null, true);
                        // if this instance is the primary instance and the election is still pending, it will
                        // finalize the primary election.
                        if (this._primaryInfo && this._selfInstance.InstanceId === this._primaryInfo.InstanceId &&
                            this._primaryRecord && this._primaryRecord.voteState === 'pending') {
                            // if election couldn't be finalized, remove the current election so someone else
                            // could start another election
                            if (!await this.platform.finalizePrimaryElection(this._selfInstance.InstanceId, this._primaryRecord)) {
                                await this.platform.removePrimaryRecord();
                                this._primaryRecord = null;
                            } else {
                                this._primaryRecord.voteState = 'done';
                            }
                        }
                    } catch (error) {
                        // if error occurs, check who is holding a primary election, if it is this instance,
                        // terminates this election. then continue
                        await this.retrievePrimary(null, true);

                        if (this._primaryRecord.instanceId === this._selfInstance.InstanceId ) {
                            await this.platform.removePrimaryRecord();
                        }
                        
                        throw new Error('Failed to determine the primary instance within ' +
                            `${process.env.SCRIPT_EXECUTION_EXPIRE_TIME} seconds. This instance is unable` +
                            ' to bootstrap. Please report this to administrators.');
                        
                    }
                }
                // update instance hb next time
                let now = Date.now();
                await this.platform.updateInstanceHealthCheck(selfHealthCheck, heartBeatInterval, 0, now);
                logger.info(`hb record updated on (timestamp: ${now}, instance id:` +
                `${this._selfInstance.InstanceId}, ` +
                `ip: ${this._selfInstance.PrivateIpAddress}) health check ` +
                `(${selfHealthCheck.healthy ? 'healthy' : 'unhealthy'}, ` +
                `heartBeatLossCount: ${selfHealthCheck.heartBeatLossCount}, ` +
                `nextHeartBeatTime: ${selfHealthCheck.nextHeartBeatTime}.`
                );
            }
            
            
            if (this._primaryInfo &&
                this._primaryRecord && this._primaryRecord.voteState === 'done') {
                let fadcfgsyncport = await this.findFortiADCCfgSyncPort(event, this._selfInstance.InstanceId === this._primaryInfo.InstanceId);
                if (fadcfgsyncport) {
                    logger.info(`fadcfgsyncport: ${fadcfgsyncport}`);
                    return {'primary-ip':this._primaryInfo.PrivateIpAddress, 'config-sync-port':fadcfgsyncport};
                } else {
                    return {'primary-ip':this._primaryInfo.PrivateIpAddress, 'config-sync-port':10443};
                }
            }
            return {};
        }
    }

    async handleGetConfigCallback(isPrimary, statusSuccess, primary_record) {
        await this.completeGetConfigLifecycleAction(
                this._selfInstance.InstanceId, statusSuccess) ||
                new AutoScaleCore.LifecycleItem(this._selfInstance.InstanceId, {},
                    AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG);
        
        if (isPrimary) {
            await this.platform.finalizePrimaryElection(this._selfInstance.InstanceId, primary_record);
        }
        logger.info(`${this._selfInstance.InstanceId} called handleGetConfigCallback`);
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
        // check if primary
        let primaryRecord = await this.platform.getElectedPrimary();
        logger.log(`primaryRecord: ${JSON.stringify(primaryRecord)}`);
        logger.log(`lifecycle item: ${JSON.stringify(item)}`);
        if (primaryRecord && primaryRecord.instanceId === item.instanceId) {
            await this.deregisterPrimaryInstance(primaryRecord);
        }
        await this.platform.completeLifecycleAction(item, true);
        await this.platform.cleanUpDbLifeCycleActions([item], true);
        await this.platform.deleteInstanceHealthCheck(instanceId);
        logger.info(`FortiADC (instance id: ${instanceId}) is terminating, lifecyclehook(${
            event.detail.LifecycleActionToken})`);
        return;
    }

    async addInstanceToMonitor(instance, nextHeartBeatTime, heartBeatInterval = 10) {
        logger.info(`${instance.InstanceId}: ` + 'calling addInstanceToMonitor');
        var params = {
            Item: {
                instanceId: instance.InstanceId,
                ip: instance.PrivateIpAddress,
                autoScalingGroupName: process.env.AUTO_SCALING_GROUP_NAME,
                nextHeartBeatTime: nextHeartBeatTime,
                heartBeatLossCount: 0,
                heartBeatInterval: heartBeatInterval,
                bornTime:Date.now() + 0
            },
            TableName: DB.AUTOSCALE.TableName
        };
        return await docClient.put(params).promise();
    }


    async retrievePrimary(filters = null, reload = false) {
       
        if (reload) {
            this._primaryInfo = null;
            this._primaryHealthCheck = null;
            this._primaryRecord = null;
        }
        
        if (!this._primaryRecord && (!filters || filters && filters.primaryRecord)) {
            this._primaryRecord = await this.platform.getElectedPrimary();
        }
        
        if (!this._primaryInfo && (!filters || filters && filters.primaryInfo)) {
            if (this._primaryRecord) {
                this._primaryInfo = await this.getPrimaryInfo(this._primaryRecord.instanceId, this._primaryRecord.ip);
            }
        }

        if (!this._primaryHealthCheck && (!filters || filters && filters.primaryHealthCheck)) {
            if (this._primaryInfo) {
                // TODO: primary health check should not depend on the current hb
                this._primaryHealthCheck = await this.platform.getInstanceHealthCheck({
                    instanceId: this._primaryInfo.InstanceId
                });
            }
        }

        return {
            primaryInfo: this._primaryInfo,
            primaryHealthCheck: this._primaryHealthCheck,
            primaryRecord: this._primaryRecord
        };
    }

    async purgePrimary(asgName) {
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

    async deregisterPrimaryInstance(instance) {
        logger.info('calling deregisterPrimaryInstance', JSON.stringify(instance));
        return await this.purgePrimary(process.env.AUTO_SCALING_GROUP_NAME);
    }

    /* eslint-disable max-len */
    /**
     * Handle the 'getConfig' callback from the fortiadc.
     * @param {Aws.ProxyIntegrationEvent} event Event from the api-gateway.
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format // eslint-disable-line max-len
     */
    /* eslint-enable max-len */
    async handleGetConfig(event) {
        
        let
            config,
            primaryInfo,
            callingInstanceId = this.findCallingInstanceId(event);
        logger.info(`${callingInstanceId} : `+ 'calling handleGetConfig');
        // get instance object from platform
        this._selfInstance = await this.platform.describeInstance({instanceId: callingInstanceId});
        if (!this._selfInstance || this._selfInstance.VpcId !== process.env.VPC_ID) {
            // not trusted
            throw new Error(`Unauthorized calling instance (instanceId: ${callingInstanceId}).` +
            'Instance not found in VPC.');
        }

        let promiseEmitter = this.checkPrimaryElection.bind(this),
            validator = result => {
             
               if (this._primaryRecord && this._primaryRecord.voteState === 'pending' &&
                   this._selfInstance &&
                    this._primaryRecord.instanceId === this._selfInstance.InstanceId) {
                    // I am the primary
                    return true;
                }
            
                // primary info exists
                if (result) {
                    // i am the elected primary
                    if (result.PrivateIpAddress ===
                        this._selfInstance.PrivateIpAddress) {
                        return true;
                    } else if (this._primaryRecord) {
                        if (this._primaryRecord.voteState === 'done') {
                            // primary election done
                            return true;
                        } else if (this._primaryRecord.voteState === 'pending') {
                            // primary is still pending
                            return false;
                        }
                    } else {
                        // primary info exists but no primary record?
                        // this looks like a case that shouldn't happen. do the election again?
                        logger.warn('primary info found but primary record not found. retry.');
                        return false;
                    }
                } else {
                    //the primary ec2 instance is not there. The primary record in db is outdated
                    //remove the primary record in db to start a primary election.
                    logger.warn('The primary ec2 instance is not there, remove the primary record');
                    this.platform.removePrimaryRecord();
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
           primaryInfo = await AutoScaleCore.waitFor(
           promiseEmitter, validator, 5000, counter);
           logger.info(`${this._selfInstance.InstanceId}: Check primary election done`);
        } catch (error) {
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            } else {
                message = error && typeof error.toString === 'function' ?
                        error.toString() : JSON.stringify(error);
            }
            logger.warn(message);
            // if error occurs, check who is holding a primary election, if it is this instance,
            // terminates this election. then tear down this instance whether it's primary or not.
            await this.retrievePrimary(null, true);
            if (this._primaryRecord.instanceId === this._selfInstance.InstanceId) {
                await this.platform.removePrimaryRecord();
            }
            await this.platform.removeInstance(this._selfInstance);
            throw new Error('Failed to determine the primary instance. This instance is unable' +
                ' to bootstrap. Please report this to' +
                ' administrators.');
        }
        // the primary ip same as mine? (diagram: primary IP same as mine?)
        if (primaryInfo.PrivateIpAddress === this._selfInstance.PrivateIpAddress) {
            this._step = 'handler:getConfig:getPrimaryConfig';
            config = await this.getPrimaryConfig(await this.platform.getCallbackEndpointUrl());
            logger.info('called handleGetConfig: returning primary role config' +
            `(primary-ip: ${primaryInfo.PrivateIpAddress}):\n ${config}`);
            await this.platform.removeOutdatedInstanceHealthCheck(this._selfInstance.InstanceId);
            return config;
        } else {

            this._step = 'handler:getConfig:getSecondaryConfig';
            config = this.getSecondaryConfig(primaryInfo.PrivateIpAddress,
                await this.platform.getCallbackEndpointUrl(), process.env.FORTIADC_SYNC_INTERFACE,
                process.env.FORTIADC_ADMIN_PORT, await this.platform.addConfigSyncPort(-1));
           
            logger.info('called handleGetConfig: returning secondary role config' +
                `(primary-ip: ${primaryInfo.PrivateIpAddress}):\n ${config}`);
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
    async findFortiADCCfgSyncPort(request, is_primary = false) {
        if (request.body && request.body !== '') {
            let cfgsyncport = 10443;
            try {
                let jsonBodyObject = JSON.parse(request.body);
                if (jsonBodyObject.cfgsyncport && is_primary) {
                    logger.info('called findFortiADCCfgSyncPort: ' +
                    `config sync port ${jsonBodyObject.cfgsyncport} found`);
                    // add config sync port into configset
                    cfgsyncport = await this.platform.addConfigSyncPort(jsonBodyObject.cfgsyncport);
                } else {
                    logger.info('called findFortiADCCfgSyncPort: cfgsyncport not found or is not primary node');
                    //get config sync port from configset
                    cfgsyncport = await this.platform.addConfigSyncPort(-1);
                }
                //logger.info(`cfgsyncport: ${cfgsyncport}`);
                return cfgsyncport;
            } catch (ex) {
                logger.info('called findFortiADCCfgSyncPort: unexpected body content format ' +
            `(${request.body})`);
                return null;
            }
        }
    }
    async checkFortiADCImageVersion(request, is_primary = false) {
        if (request.body && request.body !== '') {
            let image = "";
            try {
                let jsonBodyObject = JSON.parse(request.body);
                if (jsonBodyObject.image) {
                    logger.info('called checkFortiADCImageVersion: image ' +
                    `${jsonBodyObject.image} found`);
                    // add config sync port into configset
                    image = await this.platform.addFortiADCImageVersion(jsonBodyObject.image, is_primary);
                    if (image != jsonBodyObject.image ) {
                        logger.warn('called checkFortiADCImageVersion: image version is incompatible');
                        return false;
                    }
                } else {
                    logger.info('called checkFortiADCImageVersion: image version not found');
                    return false;
                }
                //logger.info(`cfgsyncport: ${cfgsyncport}`);
                return true;
            } catch (ex) {
                logger.info('called checkFortiADCImageVersion: unexpected body content format ' +
            `(${request.body})`);
                return false;
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
