# FortiADC Autoscale - AWS Lambda

This is a complete Fortiadc Autoscale handler script source code for AWS Cloud Platform. A 'simple' autoscaling setup which takes advantage of the 5.4.0 `auto-scale` callback feature to automate autoscaling group config syncronization.

## Install

To make a deployment package, run `npm run build-aws-lambda`.

The entry point of this Lambda function is: index.AutoscaleHandler.


## Scope and Limits

This Lambda function is inteded to use as a component of the fortiadc Autoscale solution for AWS. Please refer to the main project at https://github.com/fortinet/fortigate-autoscale for more information.

## License
[License](https://github.com/fortinet/fortigate-autoscale/blob/master/LICENSE) © Fortinet Technologies. All rights reserved.