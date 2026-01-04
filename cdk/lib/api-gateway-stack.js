"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiGatewayStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
class ApiGatewayStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const allowAllOrigins = props.allowedOrigins.length === 0 || props.allowedOrigins.includes('*');
        const corsAllowOrigins = allowAllOrigins
            ? apigateway.Cors.ALL_ORIGINS
            : props.allowedOrigins;
        const allowCredentials = !allowAllOrigins;
        const errorOrigin = allowAllOrigins ? '*' : props.allowedOrigins[0] || '*';
        const corsAllowHeadersList = [
            'Content-Type',
            'Authorization',
            'X-Amz-Date',
            'X-Api-Key',
            'X-Amz-Security-Token',
            'X-Requested-With',
            'x-user-id',
            'x-id-token'
        ];
        const corsAllowHeaders = corsAllowHeadersList.join(',');
        const restApi = new apigateway.RestApi(this, 'PublicApi', {
            restApiName: `riftbound-${props.environment}-api`,
            description: `Public API gateway for Riftbound Online ${props.environment}`,
            deployOptions: {
                stageName: props.environment,
                metricsEnabled: true,
                tracingEnabled: true,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: corsAllowOrigins,
                allowMethods: apigateway.Cors.ALL_METHODS,
                allowHeaders: corsAllowHeadersList,
                allowCredentials,
            },
        });
        const integrationResponses = [
            {
                statusCode: '200',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': 'integration.response.header.Access-Control-Allow-Origin',
                    'method.response.header.Access-Control-Allow-Headers': 'integration.response.header.Access-Control-Allow-Headers',
                    'method.response.header.Access-Control-Allow-Methods': 'integration.response.header.Access-Control-Allow-Methods',
                    'method.response.header.Access-Control-Allow-Credentials': 'integration.response.header.Access-Control-Allow-Credentials',
                },
            },
            {
                statusCode: '500',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': 'integration.response.header.Access-Control-Allow-Origin',
                    'method.response.header.Access-Control-Allow-Headers': 'integration.response.header.Access-Control-Allow-Headers',
                    'method.response.header.Access-Control-Allow-Methods': 'integration.response.header.Access-Control-Allow-Methods',
                    'method.response.header.Access-Control-Allow-Credentials': 'integration.response.header.Access-Control-Allow-Credentials',
                },
            },
            {
                statusCode: '400',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': 'integration.response.header.Access-Control-Allow-Origin',
                    'method.response.header.Access-Control-Allow-Headers': 'integration.response.header.Access-Control-Allow-Headers',
                    'method.response.header.Access-Control-Allow-Methods': 'integration.response.header.Access-Control-Allow-Methods',
                    'method.response.header.Access-Control-Allow-Credentials': 'integration.response.header.Access-Control-Allow-Credentials',
                },
            },
        ];
        const createIntegration = (pathSuffix, requestProxy = false) => new apigateway.HttpIntegration(`http://${props.loadBalancerDnsName}${pathSuffix ? `/${pathSuffix}` : ''}`, {
            httpMethod: 'ANY',
            proxy: true,
            options: {
                passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_MATCH,
                integrationResponses,
                requestParameters: requestProxy
                    ? {
                        'integration.request.path.proxy': 'method.request.path.proxy',
                    }
                    : undefined,
            },
        });
        const methodResponses = [
            {
                statusCode: '200',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': true,
                    'method.response.header.Access-Control-Allow-Headers': true,
                    'method.response.header.Access-Control-Allow-Methods': true,
                    'method.response.header.Access-Control-Allow-Credentials': true,
                },
            },
            {
                statusCode: '400',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': true,
                    'method.response.header.Access-Control-Allow-Headers': true,
                    'method.response.header.Access-Control-Allow-Methods': true,
                    'method.response.header.Access-Control-Allow-Credentials': true,
                },
            },
            {
                statusCode: '500',
                responseParameters: {
                    'method.response.header.Access-Control-Allow-Origin': true,
                    'method.response.header.Access-Control-Allow-Headers': true,
                    'method.response.header.Access-Control-Allow-Methods': true,
                    'method.response.header.Access-Control-Allow-Credentials': true,
                },
            },
        ];
        const graphqlResource = restApi.root.addResource('graphql');
        graphqlResource.addMethod('ANY', createIntegration('graphql'), {
            methodResponses,
        });
        const proxyResource = restApi.root.addResource('{proxy+}');
        proxyResource.addMethod('ANY', createIntegration('{proxy}', true), {
            authorizationType: apigateway.AuthorizationType.NONE,
            requestParameters: {
                'method.request.path.proxy': true,
            },
            methodResponses,
        });
        restApi.addGatewayResponse('Default4xxWithCors', {
            type: apigateway.ResponseType.DEFAULT_4XX,
            responseHeaders: {
                'Access-Control-Allow-Origin': `'${errorOrigin}'`,
                'Access-Control-Allow-Headers': `'${corsAllowHeaders}'`,
                'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
                'Access-Control-Allow-Credentials': allowCredentials ? "'true'" : "'false'",
            },
            statusCode: '400',
        });
        restApi.addGatewayResponse('Default5xxWithCors', {
            type: apigateway.ResponseType.DEFAULT_5XX,
            responseHeaders: {
                'Access-Control-Allow-Origin': `'${errorOrigin}'`,
                'Access-Control-Allow-Headers': `'${corsAllowHeaders}'`,
                'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
                'Access-Control-Allow-Credentials': allowCredentials ? "'true'" : "'false'",
            },
            statusCode: '500',
        });
        this.apiUrl = restApi.url;
        new cdk.CfnOutput(this, 'ApiGatewayUrl', {
            value: restApi.url,
            description: 'Public API endpoint for UI traffic',
            exportName: `riftbound-${props.environment}-api-url`,
        });
    }
}
exports.ApiGatewayStack = ApiGatewayStack;
//# sourceMappingURL=api-gateway-stack.js.map